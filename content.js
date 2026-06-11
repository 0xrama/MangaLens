// MangaLens Content Script — runs on webtoons.com viewer pages
// OCR + Translation via Kimi K2.6 Vision API

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────
  let isTranslating = false;
  let translatedCount = 0;
  const processedImages = new Set(); // track already-translated image URLs

  // ── Config ─────────────────────────────────────────────────────────
  const API_BASE = 'https://api.moonshot.ai/v1/chat/completions';
  const MODEL = 'kimi-k2.5';

  // ── Helpers ────────────────────────────────────────────────────────

  function getAllPanelImages() {
    // webtoons.com uses img._images inside #_imageList
    // src is a transparent placeholder, real URL is in data-url
    return Array.from(document.querySelectorAll('#_imageList img._images'));
  }

  function getRealImageSrc(img) {
    return img.getAttribute('data-url') || img.src;
  }

  // Fetch image as blob and convert to base64
  async function imageToBase64(url) {
    const resp = await fetch(url);
    const blob = await resp.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // Detect if an image likely contains text (skip very small / warning images)
  function shouldProcess(img) {
    const w = parseFloat(img.getAttribute('width')) || img.naturalWidth || 0;
    const h = parseFloat(img.getAttribute('height')) || img.naturalHeight || 0;
    // Skip tiny images and warning banners (typically square-ish, small)
    return w >= 400 && h >= 400;
  }

  // ── Translation Overlay ────────────────────────────────────────────

  function createTranslationOverlay(img, translations) {
    if (!translations || translations.length === 0) return;

    // Find or create a wrapper
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

    // Remove any existing overlays
    wrapper.querySelectorAll('.ml-overlay').forEach(el => el.remove());

    // Create overlay container
    const overlay = document.createElement('div');
    overlay.classList.add('ml-overlay');
    overlay.classList.add('ml-style-' + (window.__mlOverlayStyle || 'bubble'));

    translations.forEach((t, idx) => {
      const el = document.createElement('div');
      el.classList.add('ml-text-block');
      el.textContent = t.english;

      // If we have position info, use it; otherwise stack them
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

  // ── Kimi K2.6 Vision API Call ──────────────────────────────────────

  async function translateImage(base64Data, sourceLang, targetLang) {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    if (!apiKey) throw new Error('No API key. Set it in MangaLens settings.');

    const langHint = sourceLang === 'auto'
      ? 'Detect the source language automatically (Chinese, Korean, or Japanese)'
      : `The source language is ${sourceLang === 'zh' ? 'Chinese' : sourceLang === 'ko' ? 'Korean' : 'Japanese'}`;

    const targetLangName = {
      en: 'English', zh: 'Chinese', ko: 'Korean',
      ja: 'Japanese', es: 'Spanish', fr: 'French'
    }[targetLang] || 'English';

    const systemPrompt = `You are an expert manga/webtoon translator and OCR specialist. You will receive a single panel image from a webtoon or manhua. Your job:
1. Identify ALL text/speech bubbles in the image
2. Read the text using OCR (it will be in ${langHint})
3. Translate each piece of text to ${targetLangName}
4. Return a JSON array of translations

IMPORTANT RULES:
- Translate NATURALLY — use casual, natural dialogue appropriate for the context
- Preserve tone: if a character sounds angry, excited, shy etc., keep that feeling in the translation
- For sound effects (SFX), translate them to English onomatopoeia
- If text is too blurry or small to read, skip it
- If there is NO text in the image at all, return an empty array

RESPOND WITH ONLY a JSON array, no markdown, no explanation:
[{"original": "原文", "english": "translation", "position": {"x": 15, "y": 30, "width": 50}}]

Position is percentage-based (0-100) of where the text appears in the image from top-left.
If you cannot determine exact position, omit the position field.`;

    const body = {
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: base64Data }
            },
            {
              type: 'text',
              text: `Please OCR and translate all text in this webtoon panel to ${targetLangName}. Return JSON array only.`
            }
          ]
        }
      ],
      // K2.6 uses fixed temperature/top_p — do NOT set them
      max_tokens: 2048,
      thinking: { type: 'disabled' }, // disable thinking for speed on OCR tasks
    };

    const resp = await fetch(API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`API error ${resp.status}: ${errText}`);
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';

    // Parse JSON from response (handle markdown code blocks)
    let jsonStr = content.trim();
    const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    try {
      return JSON.parse(jsonStr);
    } catch {
      console.warn('[MangaLens] Failed to parse API response:', content);
      return [];
    }
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

    // Load settings
    const settings = await chrome.storage.local.get([
      'sourceLang', 'targetLang', 'overlayStyle', 'fontSize'
    ]);
    const sourceLang = settings.sourceLang || 'auto';
    const targetLang = settings.targetLang || 'en';
    window.__mlOverlayStyle = settings.overlayStyle || 'bubble';
    window.__mlFontSize = settings.fontSize || 'medium';

    // Apply font size class to body
    document.body.classList.remove('ml-font-small', 'ml-font-medium', 'ml-font-large');
    document.body.classList.add('ml-font-' + window.__mlFontSize);

    reportProgress(0, total);

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const realSrc = getRealImageSrc(img);

      // Skip already processed
      if (processedImages.has(realSrc)) {
        reportProgress(i + 1, total);
        continue;
      }

      try {
        // Wait for image to be loaded with real URL
        // webtoons uses lazy loading — data-url is set to src on scroll
        // Force load it
        if (img.getAttribute('data-url') && img.src.includes('bg_transparency')) {
          img.src = realSrc;
          await new Promise(resolve => {
            img.onload = resolve;
            img.onerror = resolve;
          });
        }

        const base64 = await imageToBase64(realSrc);
        const translations = await translateImage(base64, sourceLang, targetLang);

        if (translations.length > 0) {
          createTranslationOverlay(img, translations);
        }

        processedImages.add(realSrc);
        translatedCount = i + 1;
        reportProgress(i + 1, total);

        // Small delay to avoid rate limiting
        if (i < images.length - 1) {
          await new Promise(r => setTimeout(r, 300));
        }
      } catch (err) {
        console.error(`[MangaLens] Error translating panel ${i + 1}:`, err);
        reportError(`Panel ${i + 1}: ${err.message}`);
        // Continue with next panel
      }
    }

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
