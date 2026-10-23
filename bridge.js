// Isolated-world content script. Relays settings, the engine URL and manual
// triggers between the extension (popup, shortcut, storage) and inject.js,
// which runs in the page's own world where getUserMedia lives.
(() => {
  const TAG_TO_MAIN = 'snapvanish:bridge';
  const TAG_FROM_MAIN = 'snapvanish:main';
  let lastStatus = { cameras: 0, engine: 'idle', state: 'visible' };

  const toMain = (msg) => window.postMessage({ __snapvanish: TAG_TO_MAIN, ...msg }, '*');

  const sendInit = () => {
    chrome.storage.sync.get(SNAP_VANISH_DEFAULTS, (config) => {
      toMain({ type: 'init', engineUrl: chrome.runtime.getURL('engine.html'), config });
    });
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.__snapvanish !== TAG_FROM_MAIN) return;
    if (e.data.type === 'hello') sendInit();
    if (e.data.type === 'status') lastStatus = e.data.status;
  });

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area !== 'sync') return;
    chrome.storage.sync.get(SNAP_VANISH_DEFAULTS, (config) => toMain({ type: 'config', config }));
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'trigger') {
      toMain({ type: 'trigger', action: msg.action || 'toggle' });
      sendResponse({ ok: true, status: lastStatus });
    } else if (msg?.type === 'getStatus') {
      // Only the frame that actually owns a camera answers, so the popup
      // does not get a "no camera" reply from an unrelated iframe first.
      if (lastStatus.cameras > 0) {
        sendResponse({ ok: true, status: lastStatus });
      } else if (window === window.top) {
        setTimeout(() => sendResponse({ ok: true, status: lastStatus }), 150);
        return true;
      }
    }
  });

  sendInit();
})();
