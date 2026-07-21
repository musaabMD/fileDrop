# fileDrop

Fast PDF dropzone for extracting exam questions with OpenRouter vision models.

## What it does

- Renders PDF pages in the browser with `pdfjs-dist`.
- Sends one rendered page at a time to `/api/extract-page`.
- Validates OpenRouter JSON with Zod before showing results.
- Separates review, extracted image assets, quiz mode, and JSON export.
- Deploys to Cloudflare Workers with `@opennextjs/cloudflare`.

## Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Set `OPENROUTER_API_KEY` in `.env.local` for local extraction.

## Cloudflare

```bash
npm run deploy
npx wrangler secret put OPENROUTER_API_KEY
```

The secret must stay in Cloudflare, not in source control.

## Verification

```bash
npm run lint
npm run test
npm run build
npx opennextjs-cloudflare build
```
