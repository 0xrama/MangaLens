// MangaLens background service worker — the translation brain.
// Owns: the offscreen document (OCR + built-in translator), the persistent
// translation cache, and provider dispatch (built-in / DeepSeek / Gemini).
// API keys never leave extension contexts — the content script only ever
// sends and receives plain text.

let creatingOffscreen = null;

// ════════════════════════════════════════════════════════════════
//  Offscreen document lifecycle
// ════════════════════════════════════════════════════════════════

async function ensureOffscreenDocument() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) return;

  const offscreenUrl = chrome.runtime.getURL('offscreen.html');

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl],
    });

    if (contexts.length > 0) return;
  } else {
    const matchedClients = await clients.matchAll();
    if (matchedClients.some(client => client.url.includes(chrome.runtime.id))) return;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Local Tesseract.js OCR requires a worker context.',
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

// ════════════════════════════════════════════════════════════════
//  Persistent translation cache — one bucket per language pair.
//  Rereading a chapter hits the cache and costs $0.
// ════════════════════════════════════════════════════════════════

const CACHE_PREFIX = 'ml-tl-cache:';

function cacheKeyFor(sourceLang, targetLang) {
  return `${CACHE_PREFIX}${sourceLang}>${targetLang}`;
}

async function loadCacheBucket(sourceLang, targetLang) {
  const key = cacheKeyFor(sourceLang, targetLang);
  const data = await chrome.storage.local.get(key);
  return data[key] || {};
}

async function saveCacheEntries(sourceLang, targetLang, entries) {
  const key = cacheKeyFor(sourceLang, targetLang);
  const bucket = await loadCacheBucket(sourceLang, targetLang);
  Object.assign(bucket, entries);
  await chrome.storage.local.set({ [key]: bucket });
}

// ════════════════════════════════════════════════════════════════
//  Prompt — kept byte-identical across requests so DeepSeek's prompt
//  cache kicks in (cache-hit input is ~30x cheaper than a miss).
// ════════════════════════════════════════════════════════════════

function langDisplayName(code) {
  return {
    en: 'English', zh: 'Chinese', ko: 'Korean',
    ja: 'Japanese', es: 'Spanish', fr: 'French',
  }[code] || code;
}

function buildSystemPrompt(sourceLang, targetLang) {
  const sourceHint = sourceLang === 'auto'
    ? 'The text is OCR-extracted from a comic; detect whether it is Chinese, Korean, or Japanese yourself.'
    : `The source language is ${langDisplayName(sourceLang)}.`;
  const target = langDisplayName(targetLang);

  return `You are an expert manga/webtoon translator. You receive OCR-extracted text lines from a webtoon panel as JSON: {"items":[{"id":"0","text":"..."}]}.
${sourceHint}
Translate each line to ${target}.

RULES:
- Translate NATURALLY — casual, natural dialogue that fits the scene
- Preserve tone: anger, excitement, shyness, etc.
- For sound effects (SFX), use ${target} onomatopoeia
- If a line is already ${target} or untranslatable OCR noise, return it unchanged
- Reply with ONLY a JSON object, no markdown: {"translations":[{"id":"0","english":"..."}]} with ids matching the input`;
}

// ════════════════════════════════════════════════════════════════
//  Providers — each returns { originalText: translatedText }
// ════════════════════════════════════════════════════════════════

function parseTranslationJson(content, texts) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Model returned unparseable JSON: ' + content.slice(0, 120));
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new Error('Model returned unparseable JSON: ' + match[0].slice(0, 120));
    }
  }

  const list = parsed.translations || (Array.isArray(parsed) ? parsed : []);
  const byId = new Map();
  list.forEach((item, index) => {
    const id = item && item.id !== undefined ? String(item.id) : String(index);
    byId.set(id, item);
  });

  const map = {};
  texts.forEach((text, index) => {
    const entry = byId.get(String(index)) || list[index] || {};
    const out = entry.english ?? entry.translation ?? entry.translated ?? text;
    map[text] = String(out).trim() || text;
  });
  return map;
}

async function translateViaDeepSeek(texts, sourceLang, targetLang, settings) {
  const apiKey = settings.apiKey;
  if (!apiKey) throw new Error('No DeepSeek API key set. Add one in MangaLens settings.');

  const body = {
    model: settings.deepseekModel || 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: buildSystemPrompt(sourceLang, targetLang) },
      {
        role: 'user',
        content: JSON.stringify({ items: texts.map((text, i) => ({ id: String(i), text })) }),
      },
    ],
    response_format: { type: 'json_object' },
    // ~96 tokens covers a typical translated line; scales with batch size
    max_tokens: Math.min(8192, texts.length * 96 + 256),
    temperature: 0.2,
    // Thinking mode is ON by default on v4 models — pointless tokens for
    // short dialogue lines. Disable it; temperature works again too.
    thinking: { type: 'disabled' },
  };

  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`DeepSeek error ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  return parseTranslationJson(content, texts);
}

async function translateViaGemini(texts, sourceLang, targetLang, settings) {
  const apiKey = settings.geminiKey;
  if (!apiKey) throw new Error('No Gemini API key set. Add one in MangaLens settings.');

  const model = settings.geminiModel || 'gemini-2.5-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: buildSystemPrompt(sourceLang, targetLang) }] },
      contents: [{
        role: 'user',
        parts: [{ text: JSON.stringify({ items: texts.map((text, i) => ({ id: String(i), text })) }) }],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
        maxOutputTokens: Math.min(8192, texts.length * 96 + 256),
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`Gemini error ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }

  const data = await resp.json();
  const content = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  return parseTranslationJson(content, texts);
}

async function translateViaBuiltin(texts, sourceLang, targetLang) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    action: 'builtinTranslate',
    texts,
    sourceLang,
    targetLang,
  });
  if (!response || !response.ok) {
    throw new Error(response?.error || 'Built-in translator failed in offscreen document.');
  }
  return response.translations;
}

// Try the user's chosen provider first; if it fails, fall back to anything
// else that's configured. "Never lose bank, never lose the chapter."
async function translateWithFallback(texts, sourceLang, targetLang, settings) {
  const provider = settings.provider || 'builtin';

  const candidates = [
    { name: 'builtin', run: () => translateViaBuiltin(texts, sourceLang, targetLang) },
    {
      name: 'deepseek',
      run: () => translateViaDeepSeek(texts, sourceLang, targetLang, settings),
      needs: () => !!settings.apiKey,
    },
    {
      name: 'gemini',
      run: () => translateViaGemini(texts, sourceLang, targetLang, settings),
      needs: () => !!settings.geminiKey,
    },
  ].filter(c => c.name === provider || !c.needs || c.needs());

  // Selected provider first, remaining configured ones as fallbacks
  candidates.sort((a, b) => (a.name === provider ? -1 : 0) - (b.name === provider ? -1 : 0));

  const errors = [];
  for (const candidate of candidates) {
    try {
      const translations = await candidate.run();
      return { translations, provider: candidate.name };
    } catch (err) {
      console.warn(`[MangaLens] Provider "${candidate.name}" failed:`, err.message);
      errors.push(`${candidate.name}: ${err.message}`);
    }
  }
  throw new Error('All providers failed — ' + errors.join(' | '));
}

// ════════════════════════════════════════════════════════════════
//  Batch handler — cache check, dedupe, dispatch, cache write-back
// ════════════════════════════════════════════════════════════════

async function handleTranslateBatch({ texts, sourceLang, targetLang }) {
  const settings = await chrome.storage.local.get([
    'provider', 'apiKey', 'geminiKey', 'deepseekModel', 'geminiModel',
  ]);

  const bucket = await loadCacheBucket(sourceLang, targetLang);
  const fresh = texts.filter(text => !(text in bucket));

  let providerUsed = 'cache';
  if (fresh.length > 0) {
    const result = await translateWithFallback(fresh, sourceLang, targetLang, settings);
    providerUsed = result.provider;
    await saveCacheEntries(sourceLang, targetLang, result.translations);
    Object.assign(bucket, result.translations);
  }

  const translations = {};
  for (const text of texts) translations[text] = bucket[text] ?? text;

  return { translations, providerUsed };
}

// ════════════════════════════════════════════════════════════════
//  Message router
// ════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'translationProgress') {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
  if (msg.action === 'translationComplete') {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
  if (msg.action === 'translationError') {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
  if (msg.action === 'ocrPanel') {
    ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage(msg))
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.action === 'translateBatch') {
    handleTranslateBatch(msg)
      .then(result => sendResponse({ ok: true, translations: result.translations, providerUsed: result.provider }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
