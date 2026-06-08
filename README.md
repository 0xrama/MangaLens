# MangaLens — Webtoon Translator 📖

A Chrome extension that uses **Kimi K2.6 Vision AI** to OCR and translate webtoon/manhua panels in-place on webtoons.com.

> ⚠️ **Beta** — Early release, expect rough edges. Will be updated frequently.

## Features

- In-browser OCR via Kimi's Vision API
- Auto-detects Chinese (Simplified & Traditional), Korean, Japanese
- Multiple overlay styles (speech bubble, pill badge, solid box)
- Non-destructive — clear translations anytime

## Quick Start

1. Get an API key from [platform.moonshot.ai](https://platform.moonshot.ai/console/api-keys)
2. Open Chrome → `chrome://extensions/` → Enable **Developer mode** → **Load unpacked** → select this folder
3. Click the extension icon → **Settings** → paste your API key → save
4. Open a webtoon on webtoons.com → click **Translate This Chapter**

## Tech

- Chrome Extension (MV3)
- Uses the [Moonshot Kimi K2.6](https://platform.moonshot.ai) API for vision + translation
- Supports `webtoons.com` viewer pages

## License

MIT
