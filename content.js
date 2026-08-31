// MangaLens Content Script — runs on webtoons.com viewer pages.
// Pipeline per chunk of panels: local OCR (offscreen doc) → dedupe → ONE
// batched translation request via the background worker → overlays.
// Only extracted TEXT ever leaves the browser; images never do.

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────
  let isTranslating = false;
  let translatedCount = 0;
  const processedImages = new Set();

  // ── Config ─────────────────────────────────────────────────────────
  // Panels per translation request. Batching amortizes the prompt across
  // panels; ~8 keeps overlays flowing progressively.
  const CHUNK_SIZE = 8;

  // ── Helpers ────────────────────────────────────────────────────────

  function getAllPanelImages() {
    return Array.from(document.querySelectorAll('#_imageList img._images'));
  }

  function getRealImageSrc(img) {
    return img.getAttribute('data-url') || img.src;
  }

  function shouldProcess(img) {
    const w = parseFloat(img.getAttribute('width')) || img.naturalWidth || 0;
    const h = parseFloat(img.getAttribute('height')) || img.naturalHeight || 0;
    return w >= 400 && h >= 400;
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response);
        }
      });
    });
  }

  // ── Translation Overlay ────────────────────────────────────────────

  function createTranslationOverlay(img, translations) {
    if (!translations || translations.length === 0) return;

    let wrapper = img.parentElement;
    if (!wrapper.classList.contains('ml-wrapper')) {
      wrapper = document.createElement('div');
      wrapper.classList.add('ml-wrapper');
      wrapper.style.position = 'relative';
      wrapper.style.width = img.style.width || img.width + 'px';
      wrapper.style.maxWidth = '100%';
      img.parentNode.insertBefore(wrapper, img);
      wrapper.appendChild(img);
    }

    wrapper.querySelectorAll('.ml-overlay').forEach(el => el.remove());

    const overlay = document.createElement('div');
    overlay.classList.add('ml-overlay');
    overlay.classList.add('ml-style-' + (window.__mlOverlayStyle || 'bubble'));

    translations.forEach(t => {
      const el = document.createElement('div');
      el.classList.add('ml-text-block');
      el.textContent = t.english;

      if (t.position) {
        el.style.position = 'absolute';
        el.style.left = t.position.x + '%';
        el.style.top = t.position.y + '%';
        el.style.maxWidth = (t.position.width || 80) + '%';
      }

      overlay.appendChild(el);
    });

    wrapper.appendChild(overlay);
  }

  // ── OCR (delegated to offscreen document) ───────────────────────────

  async function ocrPanel(blob, sourceLang, width, height) {
    const blobDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    const response = await sendMessage({
      action: 'ocrPanel',
      blobDataUrl,
      sourceLang,
      width,
      height,
    });

    if (!response || !response.ok) {
      throw new Error(response?.error || 'OCR failed in offscreen document.');
    }

    return response.items || [];
  }

  // ── Translation (delegated to background: cache → provider) ────────

  async function translateTexts(texts, sourceLang, targetLang) {
    const response = await sendMessage({
      action: 'translateBatch',
      texts,
      sourceLang,
      targetLang,
    });

    if (!response || !response.ok) {
      throw new Error(response?.error || 'Translation request failed.');
    }

    return response.translations || {};
  }

  // ── Main Translation Pipeline ──────────────────────────────────────

  async function startTranslation() {
    if (isTranslating) return;
    isTranslating = true;

    const images = getAllPanelImages().filter(shouldProcess);
    const total = images.length;

    if (total === 0) {
      isTranslating = false;
      return;
    }

    const settings = await chrome.storage.local.get([
      'sourceLang', 'targetLang', 'overlayStyle', 'fontSize'
    ]);
    const sourceLang = settings.sourceLang || 'auto';
    const targetLang = settings.targetLang || 'en';
    window.__mlOverlayStyle = settings.overlayStyle || 'bubble';
    window.__mlFontSize = settings.fontSize || 'medium';

    document.body.classList.remove('ml-font-small', 'ml-font-medium', 'ml-font-large');
    document.body.classList.add('ml-font-' + window.__mlFontSize);

    // Session-level dedupe: repeated SFX ("콰앙!", "THUD") are translated
    // once per run regardless of which panel they appear in.
    const sessionCache = new Map();
    let done = 0;

    reportProgress(0, total);

    for (let start = 0; start < images.length; start += CHUNK_SIZE) {
      const chunk = images.slice(start, start + CHUNK_SIZE);
      const panelItems = [];

      // 1. OCR every panel in the chunk
      for (const img of chunk) {
        const realSrc = getRealImageSrc(img);

        if (processedImages.has(realSrc)) {
          done++;
          reportProgress(done, total);
          continue;
        }

        try {
          if (img.getAttribute('data-url') && img.src.includes('bg_transparency')) {
            img.src = realSrc;
            await new Promise(resolve => {
              img.onload = resolve;
              img.onerror = resolve;
            });
          }

          const resp = await fetch(realSrc);
          const blob = await resp.blob();

          const items = await ocrPanel(blob, sourceLang, img.naturalWidth, img.naturalHeight);
          panelItems.push({ img, realSrc, items });
        } catch (err) {
          console.error('[MangaLens] OCR failed for a panel:', err);
          reportError(`OCR: ${err.message}`);
        }

        done++;
        reportProgress(done, total);
      }

      // 2. Collect unique strings the session hasn't translated yet
      const pending = new Set();
      for (const { items } of panelItems) {
        for (const item of items) {
          if (!sessionCache.has(item.text)) pending.add(item.text);
        }
      }

      // 3. ONE batched request for the chunk (background dedupes against
      //    its persistent cache and picks the provider)
      if (pending.size > 0) {
        try {
          const translations = await translateTexts([...pending], sourceLang, targetLang);
          for (const [text, translated] of Object.entries(translations)) {
            sessionCache.set(text, translated);
          }
        } catch (err) {
          console.error('[MangaLens] Translation failed for chunk:', err);
          reportError(`Translate: ${err.message}`);
        }
      }

      // 4. Render overlays for the whole chunk
      for (const { img, realSrc, items } of panelItems) {
        const overlays = items
          .map(item => ({ english: sessionCache.get(item.text), position: item.position }))
          .filter(t => t.english);

        if (overlays.length > 0) {
          createTranslationOverlay(img, overlays);
        }
        processedImages.add(realSrc);
      }

      if (start + CHUNK_SIZE < images.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    translatedCount = total;
    isTranslating = false;
    reportComplete(total);
  }

  // ── Clear Translations ─────────────────────────────────────────────

  function clearTranslations() {
    document.querySelectorAll('.ml-overlay').forEach(el => el.remove());
    document.querySelectorAll('.ml-wrapper').forEach(wrapper => {
      const img = wrapper.querySelector('img');
      if (img) {
        wrapper.parentNode.insertBefore(img, wrapper);
        wrapper.remove();
      }
    });
    processedImages.clear();
    translatedCount = 0;
  }

  // ── Progress Reporting ─────────────────────────────────────────────

  function reportProgress(current, total) {
    chrome.runtime.sendMessage({
      action: 'translationProgress',
      current,
      total,
    }).catch(() => {});
  }

  function reportComplete(total) {
    chrome.runtime.sendMessage({
      action: 'translationComplete',
      total,
    }).catch(() => {});
  }

  function reportError(error) {
    chrome.runtime.sendMessage({
      action: 'translationError',
      error,
    }).catch(() => {});
  }

  // ── Message Listener (from popup) ──────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'startTranslation') {
      startTranslation();
      sendResponse({ ok: true });
    }
    if (msg.action === 'clearTranslations') {
      clearTranslations();
      sendResponse({ ok: true });
    }
    if (msg.action === 'getStatus') {
      const images = getAllPanelImages();
      sendResponse({
        imageCount: images.filter(shouldProcess).length,
        translatedCount,
        isTranslating,
      });
    }
    return true;
  });

  console.log('[MangaLens] Content script loaded on webtoons.com viewer');
})();
