import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authenticateApiKey,
  estimateJsonBytes,
  recordUsageEvent,
  requestByteLength,
  sumOpenRouterCost,
} from "@/lib/server/api-auth";
import { getBindings } from "@/lib/server/cloudflare-bindings";
import {
  getJob,
  jobAssetKey,
  jobJsonKey,
  jobMarkdownKey,
  nowIso,
  publicAssetUrl,
} from "@/lib/server/jobs";

const assetSchema = z.object({
  id: z.string().min(1).max(160),
  pageNumber: z.number().int().positive().optional(),
  questionId: z.string().nullable().optional(),
  role: z.string().min(1).max(80).optional(),
  contentType: z.string().max(120).optional(),
  dataUrl: z.string().startsWith("data:"),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  boundingBox: z.unknown().optional(),
});

const resultSchema = z.object({
  status: z.enum(["completed", "failed"]).default("completed"),
  resultJson: z.unknown(),
  markdown: z.string().max(8_000_000).optional(),
  stats: z.unknown().optional(),
  usage: z.unknown().optional(),
  errorMessage: z.string().max(4000).nullable().optional(),
  processingMs: z.number().int().nonnegative().optional(),
  assets: z.array(assetSchema).max(500).optional(),
});

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const startedAt = Date.now();
  const { jobId } = await context.params;
  const format = new URL(request.url).searchParams.get("format");

  try {
    const { DB, FILES } = await getBindings();
    const auth = await authenticateApiKey(request, DB);

    if (auth instanceof NextResponse) {
      return auth;
    }

    const job = await getJob(DB, jobId);

    if (!job) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    const key = format === "markdown" ? job.result_markdown_key : job.result_json_key;

    if (!key) {
      return NextResponse.json({ error: "Result is not ready." }, { status: 404 });
    }

    const object = await FILES.get(key);

    if (!object) {
      return NextResponse.json({ error: "Stored result missing." }, { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata?.(headers);
    headers.set("cache-control", "private, max-age=60");

    await recordUsageEvent(DB, {
      apiKeyId: auth.apiKeyId ?? job.api_key_id,
      jobId,
      route: "/api/jobs/:jobId/result",
      method: "GET",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestBytes: requestByteLength(request),
      responseBytes: null,
      meta: { authenticated: auth.authenticated, format: format ?? "json" },
    });

    return new Response(object.body, { headers });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Could not load result.",
        message: error instanceof Error ? error.message : "Unknown error.",
      },
      { status: 503 },
    );
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const startedAt = Date.now();
  const { jobId } = await context.params;
  const parsed = resultSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid result payload.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const { DB, FILES } = await getBindings();
    const auth = await authenticateApiKey(request, DB);

    if (auth instanceof NextResponse) {
      return auth;
    }

    const job = await getJob(DB, jobId);

    if (!job) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    const timestamp = nowIso();
    const jsonKey = jobJsonKey(jobId);
    const markdownKey = parsed.data.markdown ? jobMarkdownKey(jobId) : null;
    const stats = {
      ...(isPlainObject(parsed.data.stats) ? parsed.data.stats : {}),
      processingMs: parsed.data.processingMs ?? null,
    };
    const storedAssets = [];

    await FILES.put(jsonKey, JSON.stringify(parsed.data.resultJson, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });

    if (markdownKey && parsed.data.markdown) {
      await FILES.put(markdownKey, parsed.data.markdown, {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      });
    }

    for (const asset of parsed.data.assets ?? []) {
      const decoded = decodeDataUrl(asset.dataUrl);
      const contentType = asset.contentType ?? decoded.contentType;
      const key = jobAssetKey(jobId, asset.id, contentType);

      await FILES.put(key, decoded.bytes, { httpMetadata: { contentType } });
      await DB.prepare(
        `INSERT OR REPLACE INTO job_assets (
          id, job_id, page_number, question_id, role, key, content_type,
          width, height, bounding_box_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          asset.id,
          jobId,
          asset.pageNumber ?? null,
          asset.questionId ?? null,
          asset.role ?? "part_of_question",
          key,
          contentType,
          asset.width ?? null,
          asset.height ?? null,
          asset.boundingBox === undefined ? null : JSON.stringify(asset.boundingBox),
          timestamp,
        )
        .run();

      storedAssets.push({
        id: asset.id,
        key,
        url: publicAssetUrl(jobId, asset.id),
        contentType,
      });
    }

    await DB.prepare(
      `UPDATE processing_jobs
        SET status = ?, progress = ?, completed_at = ?, updated_at = ?,
            error_message = ?, result_json_key = ?, result_markdown_key = ?,
            usage_json = ?, stats_json = ?
        WHERE id = ?`,
    )
      .bind(
        parsed.data.status,
        parsed.data.status === "completed" ? 100 : job.progress,
        timestamp,
        timestamp,
        parsed.data.errorMessage ?? null,
        jsonKey,
        markdownKey,
        parsed.data.usage === undefined ? null : JSON.stringify(parsed.data.usage),
        JSON.stringify(stats),
        jobId,
      )
      .run();

    if (job.callback_url) {
      const callbackPayload = {
        jobId,
        status: parsed.data.status,
        resultUrl: `/api/jobs/${jobId}/result`,
        markdownUrl: markdownKey ? `/api/jobs/${jobId}/result?format=markdown` : null,
        assets: storedAssets.map(({ id, url, contentType }) => ({ id, url, contentType })),
        stats,
        usage: parsed.data.usage ?? null,
      };

      await fetch(job.callback_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(callbackPayload),
      }).catch(() => null);
    }

    const payload = {
      jobId,
      status: parsed.data.status,
      resultUrl: `/api/jobs/${jobId}/result`,
      markdownUrl: markdownKey ? `/api/jobs/${jobId}/result?format=markdown` : null,
      assets: storedAssets,
    };

    await recordUsageEvent(DB, {
      apiKeyId: auth.apiKeyId ?? job.api_key_id,
      jobId,
      route: "/api/jobs/:jobId/result",
      method: "PUT",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestBytes: requestByteLength(request),
      responseBytes: estimateJsonBytes(payload),
      openrouterCost: sumOpenRouterCost(parsed.data.usage),
      meta: {
        authenticated: auth.authenticated,
        status: parsed.data.status,
        assetCount: storedAssets.length,
      },
    });

    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      {
        error: "Could not save result.",
        message: error instanceof Error ? error.message : "Unknown error.",
      },
      { status: 503 },
    );
  }
}

function decodeDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/);

  if (!match) {
    throw new Error("Invalid data URL.");
  }

  const contentType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? "";

  if (!isBase64) {
    return { contentType, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
  }

  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return { contentType, bytes };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
