// Background service worker — relays messages between popup and content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'translationProgress') {
    // Forward progress to popup
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
  if (msg.action === 'translationComplete') {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
  if (msg.action === 'translationError') {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
});
