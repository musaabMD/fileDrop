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
  contentType: z.string().max(120).optional(),
  pageCount: z.number().int().positive().optional(),
  callbackUrl: z.string().url().optional(),
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

    const jobId = crypto.randomUUID();
    const timestamp = nowIso();

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

    const payload = {
      jobId,
      status: "created",
      statusUrl: publicStatusUrl(jobId),
      resultUrl: publicResultUrl(jobId),
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
