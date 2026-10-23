// Shared default settings (loaded by bridge.js and popup.js).
var SNAP_VANISH_DEFAULTS = {
  enabled: true,       // process the camera at all
  gesture: true,       // detect finger snaps with hand tracking
  audioAssist: true,   // use the snap "click" sound from the mic to confirm snaps
  sensitivity: 3,      // 1 (strict) .. 5 (loose)
  duration: 2.4,       // seconds for the dust to take the whole body
  wind: 'right',       // direction the dust blows: right | left | up
  muteOnVanish: true,  // mute the meeting mic while you are vanished
  debug: false         // draw hand landmarks + detector state into the video
};
