# fileDrop

Fast PDF dropzone for extracting exam questions with OpenRouter vision models.

## What it does

- Renders PDF pages in the browser with `pdfjs-dist`.
- Extracts selectable PDF MCQs locally without API cost.
- Converts extracted questions and page text to Markdown.
- Optionally runs local browser OCR with `tesseract.js` for scanned pages.
- Blocks OpenRouter vision calls unless `ENABLE_VISION_EXTRACTION=true`.
- Uses capped text-only OpenRouter cleanup to remove fake choices and reject non-question pages.
- Stores API processing jobs in D1 and JSON, Markdown, source files, and image crops in R2.
- Creates client API keys from `/admin` and tracks calls, jobs, failures, latency, and OpenRouter cost per key.
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

Apply storage before deploy:

```bash
npx wrangler d1 migrations apply filedrop --remote
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

## API

Base URL:

```text
https://filedrop.mousab-r.workers.dev
```

Admin dashboard:

```text
https://filedrop.mousab-r.workers.dev/admin
```

The admin page requires `ADMIN_TOKEN`. On this machine the deployed token is stored in:

```text
.filedrop-admin-token
```

Create a key in `/admin`; it returns a `fd_live_...` value one time. Use that key from your app:

```text
Authorization: Bearer fd_live_...
```

Create a processing job:

```bash
curl -X POST "$BASE/api/jobs" \
  -H "Authorization: Bearer $FILEDROP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"filename":"book.pdf","fileSize":12345,"contentType":"application/pdf"}'
```

Upload the original file for durable tracking:

```bash
curl -X PUT "$BASE/api/jobs/$JOB_ID/source" \
  -H "Authorization: Bearer $FILEDROP_API_KEY" \
  -H "Content-Type: application/pdf" \
  --data-binary @book.pdf
```

Save extracted output:

```bash
curl -X PUT "$BASE/api/jobs/$JOB_ID/result" \
  -H "Authorization: Bearer $FILEDROP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "status":"completed",
    "resultJson":{"questions":[],"pages":[],"warnings":[]},
    "markdown":"# Extracted book\n",
    "stats":{"totalQuestions":0,"extractedAssets":0},
    "usage":[{"provider":"openrouter","purpose":"cleanup","cost":0.0001}],
    "assets":[]
  }'
```

Read status and results:

```bash
curl "$BASE/api/jobs/$JOB_ID"
curl "$BASE/api/jobs/$JOB_ID/result"
curl "$BASE/api/jobs/$JOB_ID/result?format=markdown"
```

Text-only OpenRouter transforms for RAG/book workflows:

```bash
curl -X POST "$BASE/api/transform" \
  -H "Authorization: Bearer $FILEDROP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mode":"high_yield","text":"...extracted markdown..."}'
```

Supported modes: `rag_markdown`, `chapter_summary`, `high_yield`, `table_to_markdown`, `qa`.
These endpoints do not send page images. Vision remains disabled by default.

## Usage tracking

Usage is stored in D1:

- `api_keys`: key name, prefix, status, created time, last used time.
- `api_usage_events`: endpoint, method, status code, duration, request/response size, job ID, OpenRouter cost.
- `processing_jobs.api_key_id`: links uploaded files and results to the client key.

Admin endpoints:

```bash
curl "$BASE/api/admin/api-keys" -H "Authorization: Bearer $ADMIN_TOKEN"
curl "$BASE/api/admin/usage" -H "Authorization: Bearer $ADMIN_TOKEN"
```

`REQUIRE_API_KEY=false` keeps the browser dropzone working without a key while still tracking any request that sends a key. Set `REQUIRE_API_KEY=true` in Cloudflare when your app is ready to enforce auth.

## Verification

```bash
npm run lint
npm run test
npm run build
npx opennextjs-cloudflare build
```
