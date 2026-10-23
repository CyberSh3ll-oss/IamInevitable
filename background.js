// Keyboard shortcut (Alt+Shift+S by default) -> toggle the effect in the active tab.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'snap') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'trigger', action: 'toggle' }).catch(() => {});
});
