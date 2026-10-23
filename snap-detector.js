// Finger-snap detector working on MediaPipe hand landmarks.
//
// A snap has two phases, and both must be seen on the same raised hand:
//   1. LOADED: thumb tip pressed against the middle fingertip, middle finger
//      reaching up (not a fist), held for a moment.
//   2. RELEASED: within a fraction of a second the thumb and middle finger
//      fly apart and the middle fingertip slaps down into the palm.
//
// Things that are deliberately NOT snaps:
//   - hands low in the frame or touching its bottom edge (typing, resting)
//   - small/far or low-confidence hands
//   - a pinch that slowly opens, or the release seen without the loaded pose
//   - a click sound on its own; the microphone only helps when the camera
//     already saw the loaded pose and a partial release (or the hand blurred
//     out of view right after a clearly loaded pose)
//
// Pure logic, no DOM: used by engine.js and by the offline evaluator.

// Landmark indices
const WRIST = 0, THUMB_TIP = 4, MIDDLE_MCP = 9, MIDDLE_TIP = 12, RING_TIP = 16, PINKY_TIP = 20;

export function handFeatures(lm, aspect) {
  const d = (a, b) => Math.hypot((lm[a].x - lm[b].x) * aspect, lm[a].y - lm[b].y);
  const size = d(WRIST, MIDDLE_MCP);
  let minY = 1, maxY = 0, minX = 1, maxX = 0;
  for (const p of lm) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
  }
  return {
    size,
    tm: d(THUMB_TIP, MIDDLE_TIP) / size,   // thumb tip <-> middle tip
    mw: d(MIDDLE_TIP, WRIST) / size,       // middle tip <-> wrist (extended ~1.4+, folded < 1)
    rw: d(RING_TIP, WRIST) / size,         // ring tip <-> wrist
    pw: d(PINKY_TIP, WRIST) / size,        // pinky tip <-> wrist
    wx: lm[WRIST].x * aspect,
    wy: lm[WRIST].y,
    minX, maxX, minY, maxY,
  };
}

// Sensitivity 1 (strict) .. 5 (loose)
function thresholds(sensitivity) {
  const s = Math.min(5, Math.max(1, Number(sensitivity) || 3));
  return {
    pinch: 0.22 + 0.03 * s,        // loaded: thumb-middle closer than this (x hand size)
    loadedMinMW: 1.2 - 0.03 * s,   // loaded: middle finger reaching out, not a fist
    loadMs: 130 - 15 * s,          // loaded pose must be held this long ...
    loadFrames: 2,                 // ... or seen in this many consecutive detections
    release: 0.75 - 0.04 * s,      // released: thumb-middle further apart than this
    foldTo: 0.95 + 0.03 * s,       // released: middle tip within this of the wrist
    foldDrop: 0.42 - 0.04 * s,     // released: middle tip dropped at least this much
    windowMs: 300 + 25 * s,        // loaded -> released must happen this fast
    minSize: 0.075 - 0.007 * s,    // hand must be reasonably big in the frame
    minScore: 0.75 - 0.05 * s,     // MediaPipe handedness confidence
    maxWristY: 0.86 + 0.02 * s,    // wrist must be above this (raised hand)
  };
}

export class SnapDetector {
  constructor() {
    this.reset();
  }

  reset() {
    this.load = null;     // { since, last, frames, mw, x, y, size }
    this.lostAt = 0;      // when a loaded hand disappeared (motion blur)
    this.info = [];       // per-hand features of the last update, for debug overlays
    this.reason = '';     // why the last snap fired
    this.lastNow = 0;
    this.frameMs = 33;    // smoothed time between updates
  }

  get armed() {
    return !!this.load && this.load.ready;
  }

  // hands: [{ lm: [{x,y}...21], score }], returns true when a snap completes.
  update(hands, { aspect, now, sensitivity = 3, audioPeakAt = -1e9, useAudio = true }) {
    const T = thresholds(sensitivity);
    // Slow computers see fewer frames: stretch the timing windows to match,
    // and let one strongly loaded frame count when frames are far apart.
    if (this.lastNow) this.frameMs = this.frameMs * 0.8 + Math.min(400, now - this.lastNow) * 0.2;
    this.lastNow = now;
    const slow = this.frameMs > 90;
    T.windowMs = Math.max(T.windowMs, this.frameMs * 2.2);
    const sameMs = Math.max(250, this.frameMs * 2.5);
    const load = this.load;
    const clickNear = useAudio && Math.abs(now - audioPeakAt) < 300;
    this.info = [];
    let sawLoadedHand = false;
    let fired = false;

    for (const h of hands) {
      const f = handFeatures(h.lm, aspect);
      const usable = (h.score ?? 1) >= T.minScore && f.size >= T.minSize &&
        f.wy <= T.maxWristY && f.maxY < 0.985 && f.minX > 0.005 && f.maxX < 0.995;
      const loadedPose = usable && f.tm < T.pinch && f.mw > T.loadedMinMW;
      this.info.push({ ...f, usable, loadedPose, score: h.score });

      if (loadedPose) {
        sawLoadedHand = true;
        const same = load && now - load.last < sameMs && Math.hypot(f.wx - load.x, f.wy - load.y) < 1.5 * Math.max(f.size, load.size);
        if (same) {
          load.last = now; load.frames++; load.mw = Math.max(load.mw * 0.6 + f.mw * 0.4, f.mw * 0.9);
          load.x = f.wx; load.y = f.wy; load.size = f.size;
        } else {
          this.load = { since: now, last: now, frames: 1, mw: f.mw, x: f.wx, y: f.wy, size: f.size, ready: false };
        }
        const L = this.load;
        L.ready = L.frames >= T.loadFrames || now - L.since >= T.loadMs || (slow && f.tm < T.pinch * 0.6);
        continue;
      }

      // A released hand only counts right after a ready loaded pose, at the same spot.
      if (!load || !load.ready || now - load.last > T.windowMs) continue;
      if (Math.hypot(f.wx - load.x, f.wy - load.y) > 2.0 * Math.max(f.size, load.size)) continue;
      if ((h.score ?? 1) < T.minScore - 0.1 || f.size < T.minSize * 0.8) continue;
      const folded = f.mw < T.foldTo && f.mw < load.mw - T.foldDrop;
      if (f.tm > T.release && folded) {
        fired = true;
        this.reason = 'vision';
      } else if (clickNear && f.tm > T.release * 0.7 && f.mw < load.mw - T.foldDrop * 0.6) {
        fired = true;
        this.reason = 'vision+click';
      }
    }

    // Fast snaps blur the hand so tracking drops out. Accept that only for a
    // clearly loaded, raised hand that vanished right before a sharp click.
    if (!fired && load && load.ready && !sawLoadedHand && hands.length === 0) {
      if (!this.lostAt || this.lostAt < load.last) this.lostAt = now;
      const strongLoad = load.frames >= 3 && load.y < T.maxWristY - 0.1;
      if (useAudio && strongLoad && now - load.last < 400 && audioPeakAt >= load.last - 50 && audioPeakAt <= now) {
        fired = true;
        this.reason = 'blur+click';
      }
    }

    if (load && !sawLoadedHand && now - load.last > T.windowMs + 150) this.load = null;
    if (fired) {
      this.where = { x: load.x / aspect, y: load.y }; // wrist position (0..1) of the snapping hand
      this.load = null;
    }
    return fired;
  }
}
