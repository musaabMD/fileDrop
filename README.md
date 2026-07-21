# fileDrop

Fast PDF dropzone for extracting exam questions with OpenRouter vision models.

## What it does

- Renders PDF pages in the browser with `pdfjs-dist`.
- Extracts selectable PDF MCQs locally without API cost.
- Converts extracted questions and page text to Markdown.
- Optionally runs local browser OCR with `tesseract.js` for scanned pages.
- Blocks OpenRouter vision calls unless `ENABLE_VISION_EXTRACTION=true`.
- Separates review, Markdown, extracted image assets, quiz mode, and JSON export.
- Deploys to Cloudflare Workers with `@opennextjs/cloudflare`.

## Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Set `OPENROUTER_API_KEY` in `.env.local` for local extraction.

By default, OpenRouter vision extraction is disabled. Native PDF text and local
OCR do not require an API key.

## Cloudflare

```bash
npm run deploy
npx wrangler secret put OPENROUTER_API_KEY
```

The secret must stay in Cloudflare, not in source control. Keep
`ENABLE_VISION_EXTRACTION=false` unless the OpenRouter key has a hard budget.

## Verification

```bash
npm run lint
npm run test
npm run build
npx opennextjs-cloudflare build
```
