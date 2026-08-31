// MangaLens offscreen document — two jobs, both fully on-device:
//   1. Tesseract.js OCR (worker + WASM live here, free of page CSP restrictions)
//   2. Chrome built-in Translator API (free, on-device — needs a DOM context,
//      so it can NOT run in the service worker)

let ocrWorker = null;
let ocrWorkerLangs = '';

const TESSERACT_CORE_PATH = chrome.runtime.getURL('vendor/tesseract');
const TESSERACT_WORKER_PATH = chrome.runtime.getURL('vendor/tesseract/worker.min.js');
const TESSERACT_LANG_PATH = chrome.runtime.getURL('vendor/tesseract/lang');

// ════════════════════════════════════════════════════════════════
//  OCR
// ════════════════════════════════════════════════════════════════

async function ensureOcrWorker(sourceLang) {
  const langs = getOcrLangs(sourceLang);
  const key = langs.join('+');

  if (ocrWorker && ocrWorkerLangs === key) return ocrWorker;

  if (ocrWorker) {
    await ocrWorker.terminate();
    ocrWorker = null;
  }

  ocrWorker = await Tesseract.createWorker(langs, 1, {
    workerPath: TESSERACT_WORKER_PATH,
    corePath: TESSERACT_CORE_PATH,
    langPath: TESSERACT_LANG_PATH,
    workerBlobURL: false,
    gzip: true,
  });
  ocrWorkerLangs = key;
  return ocrWorker;
}

function getOcrLangs(sourceLang) {
  if (sourceLang === 'zh') return ['chi_sim', 'eng'];
  if (sourceLang === 'ko') return ['kor', 'eng'];
  if (sourceLang === 'ja') return ['jpn', 'eng'];
  return ['eng', 'chi_sim', 'kor', 'jpn'];
}

// Stylized comic lettering is much easier for Tesseract after normalization:
// upscale to ~2x, strip color, stretch contrast, and flip dark-background
// bubbles to dark-text-on-light. All cheap canvas work — no network, no API.
async function preprocessForOcr(dataUrl) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();

  const MAX_DIM = 2400;
  // Never downscale: tall webtoon strips would shrink to unusable sizes.
  // Upscale small panels (up to 2x) for much better OCR on small text.
  const scale = Math.max(1, Math.min(2, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight)));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);

  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  const n = w * h;

  // Pass 1: grayscale + histogram
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    d[i] = d[i + 1] = d[i + 2] = g;
    hist[g]++;
    sum += g;
  }

  // 2nd/98th percentile contrast stretch (robust against a few pure
  // black/white pixels dominating min/max)
  let lo = 0, hi = 255, acc = 0;
  const loCut = n * 0.02, hiCut = n * 0.98;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= loCut) { lo = v; break; }
  }
  acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= hiCut) { hi = v; break; }
  }
  if (hi <= lo) hi = Math.min(255, lo + 1);

  // Tesseract wants dark text on a light background — invert dark panels
  const invert = sum / n < 110;
  const range = hi - lo;

  // Pass 2: stretch + optional invert
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    let g = ((d[i] - lo) * 255 / range) | 0;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    if (invert) g = 255 - g;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function linePosition(bbox, imgWidth, imgHeight) {
  if (!bbox || !imgWidth || !imgHeight) return null;
  const x = Math.max(0, Math.min(100, (bbox.x0 / imgWidth) * 100));
  const y = Math.max(0, Math.min(100, (bbox.y0 / imgHeight) * 100));
  const width = Math.max(5, Math.min(100, ((bbox.x1 - bbox.x0) / imgWidth) * 100));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width) };
}

function extractOcrItems(data, imgWidth, imgHeight) {
  const items = [];
  const blocks = data.blocks || [];

  blocks.forEach(block => {
    (block.paragraphs || []).forEach(paragraph => {
      (paragraph.lines || []).forEach(line => {
        const text = (line.text || '').replace(/\s+/g, ' ').trim();
        if (!text) return;
        const confidence = line.confidence || 0;
        if (confidence < 30) return;

        items.push({
          id: String(items.length),
          text,
          position: linePosition(line.bbox, imgWidth, imgHeight),
        });
      });
    });
  });

  return items;
}

async function runOcr(message) {
  const { blobDataUrl, sourceLang } = message;
  const worker = await ensureOcrWorker(sourceLang);
  const canvas = await preprocessForOcr(blobDataUrl);

  const { data } = await worker.recognize(canvas, {}, { blocks: true });

  // Bboxes come back in canvas space — normalize against canvas dims,
  // not the original panel size, or overlays land in the wrong spot.
  return {
    items: extractOcrItems(data, canvas.width, canvas.height),
  };
}

// ════════════════════════════════════════════════════════════════
//  Chrome built-in Translator (free, on-device, no API key)
// ════════════════════════════════════════════════════════════════

const translatorPool = new Map(); // 'zh>en' -> Translator instance

async function detectSourceLanguage(texts) {
  if (!('LanguageDetector' in self)) {
    throw new Error(
      'Auto-detect is not supported by the built-in translator. ' +
      'Pick a source language in settings, or switch to DeepSeek/Gemini.'
    );
  }
  const detector = await LanguageDetector.create();
  const sample = texts.find(t => t.length >= 8) || texts[0];
  const results = await detector.detect(sample);
  if (!results || results.length === 0) {
    throw new Error('Could not detect the source language.');
  }
  // 'zh-Hant' → base code; the zh language pack covers it well enough
  return results[0].detectedLanguage.split('-')[0];
}

async function getTranslator(sourceLang, targetLang) {
  const pairKey = sourceLang + '>' + targetLang;
  if (translatorPool.has(pairKey)) return translatorPool.get(pairKey);

  const availability = await Translator.availability({
    sourceLanguage: sourceLang,
    targetLanguage: targetLang,
  });
  if (availability === 'unavailable') {
    throw new Error(
      `Built-in translator has no ${sourceLang} → ${targetLang} language pack. ` +
      'Switch providers in settings.'
    );
  }

  const translator = await Translator.create({
    sourceLanguage: sourceLang,
    targetLanguage: targetLang,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        console.log(`[MangaLens] Translator pack download: ${Math.round(e.loaded * 100)}%`);
      });
    },
  });
  translatorPool.set(pairKey, translator);
  return translator;
}

async function translateBuiltin({ texts, sourceLang, targetLang }) {
  if (!('Translator' in self)) {
    throw new Error(
      'Chrome built-in Translator is not available in this browser ' +
      '(needs Chrome 138+, desktop). Pick DeepSeek or Gemini in settings.'
    );
  }

  let src = sourceLang;
  if (src === 'auto') src = await detectSourceLanguage(texts);
  if (src === targetLang) {
    return Object.fromEntries(texts.map(t => [t, t]));
  }

  const translator = await getTranslator(src, targetLang);

  const map = {};
  // The API processes translations sequentially anyway — feed unique texts
  // one at a time so repeated SFX cost nothing.
  for (const text of texts) {
    try {
      map[text] = (await translator.translate(text)).trim() || text;
    } catch (err) {
      console.warn('[MangaLens] Built-in translate failed for one line:', err);
      map[text] = text;
    }
  }
  return map;
}

// ════════════════════════════════════════════════════════════════
//  Message routing
// ════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.action === 'ocrPanel') {
    runOcr(message)
      .then(result => sendResponse({ ok: true, items: result.items, width: result.width, height: result.height }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message && message.action === 'builtinTranslate') {
    translateBuiltin(message)
      .then(map => sendResponse({ ok: true, translations: map }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
