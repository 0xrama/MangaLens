document.addEventListener('DOMContentLoaded', async () => {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const translateBtn = document.getElementById('translateBtn');
  const clearBtn = document.getElementById('clearBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const progressSection = document.getElementById('progressSection');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const imageCountEl = document.getElementById('imageCount');
  const translatedCountEl = document.getElementById('translatedCount');

  // Check that at least one provider is usable — the built-in translator
  // needs no key at all.
  const { provider, apiKey, geminiKey } = await chrome.storage.local.get(
    ['provider', 'apiKey', 'geminiKey']
  );
  const active = provider || 'builtin';
  const usable =
    (active === 'builtin') ||
    (active === 'deepseek' && !!apiKey) ||
    (active === 'gemini' && !!geminiKey) ||
    !!apiKey || !!geminiKey; // fallback providers configured

  if (active === 'builtin') {
    statusDot.classList.add('connected');
    statusText.textContent = 'Built-in translator · free';
    translateBtn.disabled = false;
  } else if (usable) {
    statusDot.classList.add('connected');
    statusText.textContent = `Provider: ${active}`;
    translateBtn.disabled = false;
  }

  // Get current tab and count images
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.includes('webtoons.com')) {
    chrome.tabs.sendMessage(tab.id, { action: 'getStatus' }, (res) => {
      if (chrome.runtime.lastError) {
        imageCountEl.textContent = 'N/A (not on viewer)';
        return;
      }
      if (res) {
        imageCountEl.textContent = res.imageCount ?? '—';
        translatedCountEl.textContent = res.translatedCount ?? '0';
        if (res.isTranslating) {
          progressSection.classList.add('active');
          translateBtn.disabled = true;
          translateBtn.textContent = '⏳ Translating...';
        }
        if (res.translatedCount > 0) {
          clearBtn.style.display = 'block';
        }
      }
    });
  } else {
    imageCountEl.textContent = 'N/A';
    translateBtn.disabled = true;
    translateBtn.textContent = '⚠️ Open a webtoon chapter first';
  }

  // Listen for progress updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'translationProgress') {
      progressSection.classList.add('active');
      translateBtn.disabled = true;
      translateBtn.textContent = '⏳ Translating...';
      const pct = Math.round((msg.current / msg.total) * 100);
      progressFill.style.width = pct + '%';
      progressText.textContent = `Translating panel ${msg.current} / ${msg.total}...`;
      translatedCountEl.textContent = msg.current;
    }
    if (msg.action === 'translationComplete') {
      progressSection.classList.remove('active');
      translateBtn.disabled = false;
      translateBtn.textContent = '🔄 Translate This Chapter';
      clearBtn.style.display = 'block';
      translatedCountEl.textContent = msg.total;
    }
    if (msg.action === 'translationError') {
      progressSection.classList.remove('active');
      translateBtn.disabled = false;
      translateBtn.textContent = '🔄 Translate This Chapter';
      progressText.textContent = 'Error: ' + msg.error;
    }
  });

  // Translate button
  translateBtn.addEventListener('click', () => {
    if (!tab) return;
    progressSection.classList.add('active');
    translateBtn.disabled = true;
    translateBtn.textContent = '⏳ Translating...';
    progressText.textContent = 'Starting translation...';
    chrome.tabs.sendMessage(tab.id, { action: 'startTranslation' });
  });

  // Clear button
  clearBtn.addEventListener('click', () => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { action: 'clearTranslations' }, () => {
      clearBtn.style.display = 'none';
      translatedCountEl.textContent = '0';
    });
  });

  // Settings button
  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});
