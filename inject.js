// Page-world content script. Wraps navigator.mediaDevices.getUserMedia so every
// camera track the page asks for is routed through the Snap Vanish engine
// (a hidden extension iframe running the ML + dust effect) before the meeting
// app ever sees it. Audio is passed through untouched (and optionally listened
// to for the snap "click").
(() => {
  if (window.__snapVanishInstalled) return;
  window.__snapVanishInstalled = true;

  const md = navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== 'function') return;
  if (typeof MediaStreamTrackProcessor === 'undefined' || typeof MediaStreamTrackGenerator === 'undefined') {
    console.warn('[Snap Vanish] Insertable streams unavailable; camera left untouched.');
    return;
  }

  const TAG_FROM_BRIDGE = 'snapvanish:bridge';
  const TAG_TO_BRIDGE = 'snapvanish:main';
  const FRAME_TIMEOUT_MS = 1500;

  let config = { enabled: true, gesture: true, audioAssist: true, muteOnVanish: true };
  let engineUrl = null;
  let engineUrlWaiters = [];
  let engine = null; // { win, ready, pending: Map }
  let nextFrameId = 1;
  let activeCameras = 0;
  let effectState = 'visible';
  let engineStatus = 'idle';

  const toBridge = (msg) => window.postMessage({ __snapvanish: TAG_TO_BRIDGE, ...msg }, '*');
  const reportStatus = () =>
    toBridge({ type: 'status', status: { cameras: activeCameras, engine: engineStatus, state: effectState, micMuted: !!mutedByUs && mutedByUs.via !== 'none' } });

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__snapvanish !== TAG_FROM_BRIDGE) return;
    if (d.type === 'init') {
      config = d.config;
      if (!engineUrl) {
        engineUrl = d.engineUrl;
        engineUrlWaiters.forEach((fn) => fn());
        engineUrlWaiters = [];
      }
      postToEngine({ type: 'config', config });
    } else if (d.type === 'config') {
      config = d.config;
      postToEngine({ type: 'config', config });
    } else if (d.type === 'trigger') {
      postToEngine({ type: 'trigger', action: d.action });
    }
  });
  toBridge({ type: 'hello' });

  function postToEngine(msg, transfer) {
    if (engine?.ready) engine.win.postMessage(msg, '*', transfer || []);
  }

  function waitForEngineUrl() {
    return engineUrl ? Promise.resolve() : new Promise((r) => engineUrlWaiters.push(r));
  }

  // ---- Engine iframe -------------------------------------------------------
  function ensureEngine() {
    if (engine) return;
    engine = { win: null, ready: false, pending: new Map() };
    engineStatus = 'loading';
    reportStatus();
    waitForEngineUrl().then(() => {
      const f = document.createElement('iframe');
      f.src = engineUrl;
      f.setAttribute('aria-hidden', 'true');
      f.tabIndex = -1;
      f.style.cssText =
        'position:fixed!important;width:2px!important;height:2px!important;left:-10px!important;top:-10px!important;' +
        'opacity:0!important;pointer-events:none!important;border:0!important;';
      const attach = () => (document.body || document.documentElement).appendChild(f);
      attach();
      // Some single-page apps rebuild <body>; put the engine back if it gets removed.
      new MutationObserver(() => { if (!f.isConnected) attach(); })
        .observe(document.documentElement, { childList: true, subtree: true });
      engine.win = f.contentWindow;
      window.addEventListener('message', (e) => {
        if (e.source !== f.contentWindow) return;
        const d = e.data;
        if (!d) return;
        if (d.type === 'ready') {
          engine.ready = true;
          engineStatus = 'ready';
          engine.win.postMessage({ type: 'config', config }, '*');
          reportStatus();
        } else if (d.type === 'out' || d.type === 'pass') {
          const p = engine.pending.get(d.id);
          if (p) {
            engine.pending.delete(d.id);
            p(d.bitmap || null);
          } else if (d.bitmap) {
            d.bitmap.close(); // arrived after its timeout
          }
        } else if (d.type === 'state') {
          const prevState = effectState;
          effectState = d.state;
          if (d.state === 'vanishing' && prevState !== 'vanishing') muteMic();
          if (d.state === 'appearing' && prevState !== 'appearing') unmuteMic();
          reportStatus();
        } else if (d.type === 'error') {
          engineStatus = 'error: ' + d.message;
          console.warn('[Snap Vanish] engine error:', d.message);
          reportStatus();
        }
      });
    });
  }

  function processFrame(bitmap, streamId) {
    return new Promise((resolve) => {
      const id = nextFrameId++;
      const timer = setTimeout(() => {
        if (engine.pending.delete(id)) resolve(null);
      }, FRAME_TIMEOUT_MS);
      engine.pending.set(id, (bmp) => { clearTimeout(timer); resolve(bmp); });
      engine.win.postMessage({ type: 'frame', id, streamId, bitmap }, '*', [bitmap]);
    });
  }

  // ---- Video track wrapping -----------------------------------------------
  let nextStreamId = 1;

  function wrapVideoTrack(track) {
    ensureEngine();
    const streamId = nextStreamId++;
    const processor = new MediaStreamTrackProcessor({ track });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    const reader = processor.readable.getReader();
    const writer = generator.writable.getWriter();
    let stopped = false;
    activeCameras++;
    reportStatus();

    const finish = () => {
      if (stopped) return;
      stopped = true;
      activeCameras = Math.max(0, activeCameras - 1);
      reportStatus();
      postToEngine({ type: 'release', streamId });
      try { track.stop(); } catch {}
      try { reader.cancel(); } catch {}
    };

    // One frame in flight at a time. While the engine is busy, new camera
    // frames are dropped rather than passed through raw, so a "vanished" user
    // never flickers back in; the output frame rate simply follows the engine.
    // Raw pass-through only happens when the effect is off or the engine is
    // unresponsive.
    let inFlight = false;
    let timeouts = 0;
    let retryAt = 0; // after repeated timeouts, pass raw frames until then
    const write = (f) => writer.write(f).catch(() => { try { f.close(); } catch {} });

    (async () => {
      while (!stopped) {
        let frame;
        try {
          const r = await reader.read();
          if (r.done) break;
          frame = r.value;
        } catch { break; }

        const stalled = timeouts >= 3 && performance.now() < retryAt;
        if (!config.enabled || !engine?.ready || stalled) {
          await write(frame);
          continue;
        }
        if (inFlight) {
          frame.close();
          continue;
        }
        inFlight = true;
        const timestamp = frame.timestamp;
        let bmp;
        try {
          bmp = await createImageBitmap(frame);
        } catch (err) {
          inFlight = false;
          await write(frame);
          continue;
        }
        frame.close();
        processFrame(bmp, streamId).then((res) => {
          inFlight = false;
          if (!res) {
            if (++timeouts >= 3) retryAt = performance.now() + 3000;
            return;
          }
          timeouts = 0;
          if (stopped) { res.close(); return; }
          const out = new VideoFrame(res, { timestamp });
          res.close();
          write(out);
        });
      }
      finish();
    })();

    track.addEventListener('ended', () => {
      finish();
      try { generator.stop(); } catch {}
      generator.dispatchEvent(new Event('ended'));
    });

    // Make the generated track look like the real camera to the meeting app.
    const origStop = generator.stop.bind(generator);
    Object.defineProperties(generator, {
      label: { get: () => track.label, configurable: true },
      getSettings: { value: () => track.getSettings(), configurable: true },
      getCapabilities: { value: () => track.getCapabilities?.() ?? {}, configurable: true },
      getConstraints: { value: () => track.getConstraints(), configurable: true },
      applyConstraints: { value: (c) => track.applyConstraints(c), configurable: true },
      stop: { value: () => { finish(); origStop(); }, configurable: true },
    });
    return generator;
  }

  // ---- Mute the mic while vanished ------------------------------------------
  // Preferred: press the meeting app's own mic button, so its UI and the other
  // participants see you as muted. Fallback (any site, or if the button can't
  // be found): disable the mic tracks the page got from getUserMedia, which
  // sends silence. We only ever undo a mute we made ourselves.
  const pageAudioTracks = new Set();
  let mutedByUs = null; // { via: 'button' } | { via: 'tracks', tracks } | { via: 'none' }

  function registerAudioTrack(t) {
    pageAudioTracks.add(t);
    const origClone = t.clone.bind(t);
    t.clone = () => { const c = origClone(); registerAudioTrack(c); return c; };
  }

  const MIC_RE = /micro|\bmic\b|mikrofon|микрофон|माइक|麦克风|マイク|audio/i;
  const CAM_RE = /camera|cámara|caméra|kamera|камер|video|vídeo|видео/i;
  const visible = (el) => !!(el.offsetParent || el.getClientRects().length);

  // Returns { el, muted } for the site's mic toggle, or null.
  function findMicButton() {
    const label = (el) => [el.getAttribute('aria-label'), el.getAttribute('data-tooltip'), el.getAttribute('title')]
      .filter(Boolean).join(' ');
    // Google Meet: mic and camera toggles carry data-is-muted.
    if (/(^|\.)meet\.google\.com$/.test(location.hostname)) {
      for (const el of document.querySelectorAll('[data-is-muted]')) {
        const l = label(el);
        if (!visible(el) || CAM_RE.test(l) || !MIC_RE.test(l)) continue;
        return { el, muted: el.getAttribute('data-is-muted') === 'true' };
      }
      return null;
    }
    // Teams / Zoom web and others: a visible button labelled mute/unmute + mic.
    for (const el of document.querySelectorAll('button[aria-label], [role="button"][aria-label]')) {
      const l = label(el);
      if (!visible(el) || CAM_RE.test(l) || !MIC_RE.test(l) || !/mute|turn (on|off)/i.test(l)) continue;
      const pressed = el.getAttribute('aria-pressed');
      const muted = pressed != null && /mute/i.test(l) && !/unmute/i.test(l) ? pressed === 'true' : /unmute|turn on/i.test(l);
      return { el, muted };
    }
    return null;
  }

  function muteTracks() {
    const tracks = [...pageAudioTracks].filter((t) => t.readyState === 'live' && t.enabled);
    tracks.forEach((t) => { t.enabled = false; });
    return { via: 'tracks', tracks };
  }

  function muteMic() {
    if (!config.muteOnVanish || mutedByUs) return;
    const btn = findMicButton();
    if (btn?.muted) {
      mutedByUs = { via: 'none' }; // already muted by the user: leave it alone
    } else if (btn) {
      btn.el.click();
      mutedByUs = { via: 'button' };
      // If the app ignored the click, make sure we are silent anyway.
      setTimeout(() => {
        const after = findMicButton();
        if (mutedByUs?.via === 'button' && after && !after.muted) mutedByUs = muteTracks();
      }, 400);
    } else {
      mutedByUs = muteTracks();
    }
    reportStatus();
  }

  function unmuteMic() {
    const m = mutedByUs;
    mutedByUs = null;
    if (m?.via === 'button') {
      const btn = findMicButton();
      if (btn?.muted) btn.el.click();
    } else if (m?.via === 'tracks') {
      m.tracks.forEach((t) => { if (t.readyState === 'live') t.enabled = true; });
    }
    reportStatus();
  }

  // ---- Optional mic listener for the snap "click" ---------------------------
  let audioWatch = null;
  function watchAudio(track) {
    if (audioWatch || !config.audioAssist) return;
    try {
      const clone = track.clone();
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(new MediaStream([clone]));
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2200;
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(hp).connect(an);
      const buf = new Float32Array(an.fftSize);
      let floor = 0.01;
      let lastPeak = 0;
      const resume = () => ctx.state === 'suspended' && ctx.resume();
      ['pointerdown', 'keydown'].forEach((t) => window.addEventListener(t, resume, { capture: true }));
      resume();
      const iv = setInterval(() => {
        if (clone.readyState === 'ended') return stop();
        if (!config.audioAssist || !config.enabled) return;
        an.getFloatTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > peak) peak = v; }
        const now = performance.now();
        if (peak > 0.06 && peak > floor * 6 && now - lastPeak > 250) {
          lastPeak = now;
          postToEngine({ type: 'audioPeak', strength: peak / Math.max(floor, 1e-4) });
        }
        floor = floor * 0.97 + Math.min(peak, 0.2) * 0.03;
      }, 15);
      const stop = () => {
        clearInterval(iv);
        try { clone.stop(); } catch {}
        try { ctx.close(); } catch {}
        audioWatch = null;
      };
      track.addEventListener('ended', stop);
      audioWatch = { stop };
    } catch (err) {
      console.warn('[Snap Vanish] audio assist unavailable', err);
    }
  }

  // ---- getUserMedia hook --------------------------------------------------
  const origGUM = md.getUserMedia.bind(md);
  const hooked = async function getUserMedia(constraints) {
    const stream = await origGUM(constraints);
    try {
      for (const a of stream.getAudioTracks()) {
        registerAudioTrack(a);
        watchAudio(a);
      }
      const videos = stream.getVideoTracks();
      if (!videos.length) return stream;
      const out = new MediaStream();
      for (const t of stream.getTracks()) {
        out.addTrack(t.kind === 'video' ? wrapVideoTrack(t) : t);
      }
      return out;
    } catch (err) {
      console.warn('[Snap Vanish] passing camera through untouched', err);
      return stream;
    }
  };
  Object.defineProperty(hooked, 'toString', { value: () => 'function getUserMedia() { [native code] }' });
  md.getUserMedia = hooked;
})();
