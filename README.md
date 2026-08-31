# MangaLens — Webtoon Translator 📖

A Chrome extension that OCRs webtoon/manhua panels **locally in your browser** and translates the extracted text in-place on webtoons.com. Panels never leave your machine — only extracted text lines are sent to whichever translator you pick (or none at all, with the built-in on-device translator).

> ⚠️ **Beta** — Early release, expect rough edges. Will be updated frequently.

## Translation providers (cheapest first)

| Provider | Cost | Notes |
| --- | --- | --- |
| **Browser built-in** (default) | **Free** | Chrome 138+'s on-device Translator API. No key, no network. First use downloads a language pack. |
| **Gemini Flash-Lite** | Free tier | Google AI Studio key, generous free tier. |
| **DeepSeek v4-flash** | ~**$0.001/chapter** | Thinking mode disabled, panels batched 8-at-a-time, repeated SFX deduped, identical prompt reuses DeepSeek's prompt cache (30x cheaper input). Off-peak pricing (all hours except 01:00–04:00 & 06:00–10:00 UTC Mon–Fri) halves that again. |

If your chosen provider fails, the extension automatically falls back to any other configured provider.

## Cost engineering

- **Batching** — one API call per ~8 panels, not one per panel
- **Dedupe** — repeated lines (SFX like 콰앙!) are translated once per run
- **Persistent cache** — translations stored per language pair in `chrome.storage.local`; rereading a chapter costs $0
- **Prompt cache** — the system prompt is byte-identical across requests so DeepSeek's automatic caching applies
- **No thinking mode** — v4-flash defaults to extended reasoning; pointless for dialogue lines, so it's switched off

## Features

- In-browser OCR via Tesseract.js with canvas preprocessing (2x upscale, grayscale, contrast stretch, auto-invert for dark bubbles)
- Translation via Chrome built-in Translator / DeepSeek / Gemini — your choice
- Supports Chinese, Korean, Japanese, and English OCR data
- Multiple overlay styles (speech bubble, pill badge, solid box)
- Non-destructive — clear translations anytime

## Quick Start

1. Open Chrome (138+) → `chrome://extensions/` → Enable **Developer mode** → **Load unpacked** → select this folder
2. Click the extension icon → **Translate This Chapter** — works immediately with the free built-in translator
3. Optional: open **Settings** to pick DeepSeek or Gemini for higher-quality literary translation

> Note: Tesseract OCR is bundled locally, but stylized comic text can be imperfect. Panels with clean, high-resolution text will translate best.

## Privacy

- OCR runs 100% locally (Tesseract WASM in an extension offscreen document)
- With the built-in provider, **nothing ever leaves your device**
- With DeepSeek/Gemini, only extracted text lines are sent — never panel images
- API keys live in `chrome.storage.local` and are only used from extension contexts

## Roadmap

- PaddleOCR via onnxruntime-web for heavily stylized lettering (~15MB local model)
- Vertical tiling for very tall panels (OCR each strip at full 2x resolution)
- Off-peak scheduling toggle for DeepSeek (half-price windows)

## Tech

- Chrome Extension (MV3)
- [Tesseract.js](https://github.com/naptha/tesseract.js) for local OCR
- [Chrome Translator API](https://developer.chrome.com/docs/ai/translator-api) / [DeepSeek](https://api-docs.deepseek.com) / [Gemini](https://ai.google.dev) for translation
- Supports `webtoons.com` viewer pages

## License

MIT
