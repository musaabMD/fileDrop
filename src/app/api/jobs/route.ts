import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authenticateApiKey,
  estimateJsonBytes,
  recordUsageEvent,
  requestByteLength,
} from "@/lib/server/api-auth";
import { getBindings } from "@/lib/server/cloudflare-bindings";
import { nowIso, publicResultUrl, publicStatusUrl } from "@/lib/server/jobs";

const createJobSchema = z.object({
  filename: z.string().min(1).max(260),
  fileSize: z.number().int().nonnegative().optional(),
  pageCount: z.number().int().positive().optional(),
  contentType: z.string().max(120).optional(),
  callbackUrl: z.string().url().optional(),
  sourceHash: z.string().min(32).max(128).optional(),
  sourceFingerprint: z.string().min(32).max(300).optional(),
});

export async function POST(request: Request) {
  const startedAt = Date.now();
  const parsed = createJobSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid job request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const { DB } = await getBindings();
    const auth = await authenticateApiKey(request, DB);

    if (auth instanceof NextResponse) {
      return auth;
    }

    const timestamp = nowIso();
    const fingerprint = parsed.data.sourceHash ?? null;
    const sourceFingerprint = parsed.data.sourceFingerprint ?? null;

    if (fingerprint && parsed.data.fileSize != null) {
      const existing = await DB.prepare<{
        id: string;
        status: string;
        result_json_key: string | null;
        result_markdown_key: string | null;
      }>(
        `SELECT id, status, result_json_key, result_markdown_key
         FROM processing_jobs
         WHERE source_hash = ?
           AND file_size = ?
           AND source_filename = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
        .bind(fingerprint, parsed.data.fileSize, parsed.data.filename)
        .first();

      if (existing) {
        const payload = {
          jobId: existing.id,
          status: existing.status,
          statusUrl: publicStatusUrl(existing.id),
          resultUrl: existing.result_json_key ? publicResultUrl(existing.id) : null,
          markdownUrl: existing.result_markdown_key ? `${publicResultUrl(existing.id)}?format=markdown` : null,
          reused: true,
        };

        await recordUsageEvent(DB, {
          apiKeyId: auth.apiKeyId,
          jobId: existing.id,
          route: "/api/jobs",
          method: "POST",
          statusCode: 200,
          durationMs: Date.now() - startedAt,
          requestBytes: requestByteLength(request),
          responseBytes: estimateJsonBytes(payload),
          meta: { authenticated: auth.authenticated, reused: true },
        });

        return NextResponse.json(payload);
      }
    }

    const jobId = crypto.randomUUID();

    await DB.prepare(
      `INSERT INTO processing_jobs (
        id, source_filename, source_content_type, status, file_size, page_count,
        progress, started_at, updated_at, callback_url, api_key_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        jobId,
        parsed.data.filename,
        parsed.data.contentType ?? null,
        "created",
        parsed.data.fileSize ?? null,
        parsed.data.pageCount ?? null,
        0,
        timestamp,
        timestamp,
        parsed.data.callbackUrl ?? null,
        auth.apiKeyId,
      )
      .run();

    await DB.prepare(
      `UPDATE processing_jobs
         SET source_fingerprint = ?, source_hash = ?
       WHERE id = ?`,
    )
      .bind(sourceFingerprint, fingerprint, jobId)
      .run();

    const payload = {
      jobId,
      status: "created",
      statusUrl: publicStatusUrl(jobId),
      resultUrl: publicResultUrl(jobId),
      reused: false,
    };

    await recordUsageEvent(DB, {
      apiKeyId: auth.apiKeyId,
      jobId,
      route: "/api/jobs",
      method: "POST",
      statusCode: 201,
      durationMs: Date.now() - startedAt,
      requestBytes: requestByteLength(request),
      responseBytes: estimateJsonBytes(payload),
      meta: { authenticated: auth.authenticated },
    });

    return NextResponse.json(payload, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Could not create processing job.",
        message: error instanceof Error ? error.message : "Unknown error.",
      },
      { status: 503 },
    );
  }
}
