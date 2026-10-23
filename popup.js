const $ = (id) => document.getElementById(id);
const fields = ['enabled', 'gesture', 'audioAssist', 'muteOnVanish', 'sensitivity', 'duration', 'wind', 'debug'];
const SENS_LABELS = ['', 'strict', 'firm', 'normal', 'loose', 'very loose'];

function renderOutputs() {
  $('sensitivityOut').textContent = SENS_LABELS[$('sensitivity').value];
  $('durationOut').textContent = Number($('duration').value).toFixed(1) + ' s';
}

chrome.storage.sync.get(SNAP_VANISH_DEFAULTS, (cfg) => {
  for (const k of fields) {
    const el = $(k);
    if (el.type === 'checkbox') el.checked = !!cfg[k];
    else el.value = cfg[k];
    el.addEventListener('input', () => {
      const v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
      chrome.storage.sync.set({ [k]: v });
      renderOutputs();
    });
  }
  renderOutputs();
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function showStatus(res) {
  const dot = $('statusDot');
  dot.className = 'dot';
  if (!res) {
    $('statusText').textContent = 'Not available on this page.';
    $('snap').disabled = true;
    $('captureRoom').disabled = true;
    return;
  }
  const s = res.status;
  $('snap').disabled = !s.cameras;
  if (!s.cameras) {
    $('statusText').textContent = 'No camera in use in this tab yet.';
  } else if (s.engine.startsWith('error')) {
    dot.classList.add('warn');
    $('statusText').textContent = 'Engine ' + s.engine;
  } else if (s.engine !== 'ready') {
    dot.classList.add('warn');
    $('statusText').textContent = 'Camera hooked, loading models…';
  } else {
    dot.classList.add('ok');
    $('statusText').textContent = `Camera active · you are ${s.state}` + (s.micMuted ? ' · mic muted' : '');
    $('snap').textContent = s.state === 'hidden' ? 'Snap back (reappear)' : 'Snap now (vanish)';
  }
}

async function refresh() {
  const tab = await activeTab();
  if (!tab?.id) return showStatus(null);
  try {
    showStatus(await chrome.tabs.sendMessage(tab.id, { type: 'getStatus' }));
  } catch {
    showStatus(null);
  }
}

$('snap').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab?.id) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: 'trigger', action: 'toggle' }); } catch {}
  setTimeout(refresh, 300);
});

// ---- Empty-room photo -------------------------------------------------
// Stored in chrome.storage.local as { dataUrl, updatedAt, source }.
// The engine reads the same key and listens to chrome.storage.onChanged.
let shownRoomStamp = 0;

async function loadRoomPreview() {
  const { emptyRoom } = await chrome.storage.local.get('emptyRoom');
  if (!emptyRoom) {
    shownRoomStamp = 0;
    $('roomThumb').style.backgroundImage = '';
    $('roomEmpty').hidden = false;
    return;
  }
  if (emptyRoom.updatedAt === shownRoomStamp) return;
  shownRoomStamp = emptyRoom.updatedAt;
  $('roomThumb').style.backgroundImage = `url(${emptyRoom.dataUrl})`;
  $('roomEmpty').hidden = true;
}

$('uploadRoom').addEventListener('click', () => $('roomFile').click());

$('roomFile').addEventListener('change', async () => {
  const file = $('roomFile').files[0];
  $('roomFile').value = '';
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1920 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.9);
    await chrome.storage.local.set({ emptyRoom: { dataUrl, updatedAt: Date.now(), source: 'upload' } });
    $('roomHint').textContent = 'Photo saved. Reload is not needed.';
    loadRoomPreview();
  } catch (e) {
    $('roomHint').textContent = 'Could not read that image.';
  }
});

// The engine owns the camera frames, so it does the countdown + capture
// and writes { dataUrl, updatedAt, source: 'capture' } to the same key.
$('captureRoom').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'trigger', action: 'captureRoom', seconds: 5 });
    $('roomHint').textContent = 'Step out of view now. Capturing in 5 seconds…';
    $('captureRoom').disabled = true;
    setTimeout(() => { $('captureRoom').disabled = false; $('roomHint').textContent = 'Captured. Check the preview.'; }, 9000);
  } catch {
    $('roomHint').textContent = 'Open a tab that is using your camera first.';
  }
});

refresh();
loadRoomPreview();
setInterval(() => { refresh(); loadRoomPreview(); }, 1000);
