document.addEventListener('DOMContentLoaded', async () => {
  const apiKeyInput = document.getElementById('apiKey');
  const sourceLangSelect = document.getElementById('sourceLang');
  const targetLangSelect = document.getElementById('targetLang');
  const overlayStyleSelect = document.getElementById('overlayStyle');
  const fontSizeSelect = document.getElementById('fontSize');
  const saveBtn = document.getElementById('saveBtn');
  const savedMsg = document.getElementById('savedMsg');

  // Load saved settings
  const data = await chrome.storage.local.get([
    'apiKey', 'sourceLang', 'targetLang', 'overlayStyle', 'fontSize'
  ]);
  if (data.apiKey) apiKeyInput.value = data.apiKey;
  if (data.sourceLang) sourceLangSelect.value = data.sourceLang;
  if (data.targetLang) targetLangSelect.value = data.targetLang;
  if (data.overlayStyle) overlayStyleSelect.value = data.overlayStyle;
  if (data.fontSize) fontSizeSelect.value = data.fontSize;

  saveBtn.addEventListener('click', async () => {
    await chrome.storage.local.set({
      apiKey: apiKeyInput.value.trim(),
      sourceLang: sourceLangSelect.value,
      targetLang: targetLangSelect.value,
      overlayStyle: overlayStyleSelect.value,
      fontSize: fontSizeSelect.value,
    });
    savedMsg.classList.add('show');
    setTimeout(() => savedMsg.classList.remove('show'), 2000);
  });
});
