document.addEventListener('DOMContentLoaded', async () => {
  const providerSelect = document.getElementById('provider');
  const apiKeyInput = document.getElementById('apiKey');
  const deepseekModelSelect = document.getElementById('deepseekModel');
  const geminiKeyInput = document.getElementById('geminiKey');
  const geminiModelInput = document.getElementById('geminiModel');
  const sourceLangSelect = document.getElementById('sourceLang');
  const targetLangSelect = document.getElementById('targetLang');
  const overlayStyleSelect = document.getElementById('overlayStyle');
  const fontSizeSelect = document.getElementById('fontSize');
  const saveBtn = document.getElementById('saveBtn');
  const savedMsg = document.getElementById('savedMsg');
  const clearCacheBtn = document.getElementById('clearCacheBtn');
  const cacheStats = document.getElementById('cacheStats');
  const deepseekFields = document.getElementById('deepseekFields');
  const geminiFields = document.getElementById('geminiFields');

  function syncProviderFields() {
    deepseekFields.classList.toggle('active', providerSelect.value === 'deepseek');
    geminiFields.classList.toggle('active', providerSelect.value === 'gemini');
  }

  // Load saved settings
  const data = await chrome.storage.local.get([
    'provider', 'apiKey', 'deepseekModel', 'geminiKey', 'geminiModel',
    'sourceLang', 'targetLang', 'overlayStyle', 'fontSize'
  ]);
  providerSelect.value = data.provider || 'builtin';
  if (data.apiKey) apiKeyInput.value = data.apiKey;
  if (data.deepseekModel) deepseekModelSelect.value = data.deepseekModel;
  if (data.geminiKey) geminiKeyInput.value = data.geminiKey;
  if (data.geminiModel) geminiModelInput.value = data.geminiModel;
  if (data.sourceLang) sourceLangSelect.value = data.sourceLang;
  if (data.targetLang) targetLangSelect.value = data.targetLang;
  if (data.overlayStyle) overlayStyleSelect.value = data.overlayStyle;
  if (data.fontSize) fontSizeSelect.value = data.fontSize;
  syncProviderFields();
  providerSelect.addEventListener('change', syncProviderFields);

  // Cache stats — how many cached lines per language pair
  const CACHE_PREFIX = 'ml-tl-cache:';
  async function refreshCacheStats() {
    const all = await chrome.storage.local.get(null);
    let entries = 0;
    const pairs = [];
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(CACHE_PREFIX)) {
        const count = Object.keys(value || {}).length;
        entries += count;
        pairs.push(`${key.slice(CACHE_PREFIX.length)}: ${count}`);
      }
    }
    cacheStats.textContent = entries > 0
      ? `${entries} cached line${entries === 1 ? '' : 's'} (${pairs.join(', ')}) — rereads are free.`
      : 'Cache is empty. Translations are cached per language pair — rereading a chapter is free.';
  }
  refreshCacheStats();

  clearCacheBtn.addEventListener('click', async () => {
    const all = await chrome.storage.local.get(null);
    const cacheKeys = Object.keys(all).filter(key => key.startsWith(CACHE_PREFIX));
    await chrome.storage.local.remove(cacheKeys);
    refreshCacheStats();
  });

  saveBtn.addEventListener('click', async () => {
    await chrome.storage.local.set({
      provider: providerSelect.value,
      apiKey: apiKeyInput.value.trim(),
      deepseekModel: deepseekModelSelect.value,
      geminiKey: geminiKeyInput.value.trim(),
      geminiModel: geminiModelInput.value.trim(),
      sourceLang: sourceLangSelect.value,
      targetLang: targetLangSelect.value,
      overlayStyle: overlayStyleSelect.value,
      fontSize: fontSizeSelect.value,
    });
    savedMsg.classList.add('show');
    setTimeout(() => savedMsg.classList.remove('show'), 2000);
  });
});
