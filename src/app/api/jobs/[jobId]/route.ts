import { NextResponse } from "next/server";
import { z } from "zod";
import { getBindings } from "@/lib/server/cloudflare-bindings";
import {
  getJob,
  listJobAssets,
  nowIso,
  publicAssetUrl,
  publicResultUrl,
  type JobStatus,
} from "@/lib/server/jobs";

const updateJobSchema = z.object({
  status: z.enum(["created", "uploaded", "processing", "completed", "failed"]).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  pageCount: z.number().int().positive().optional(),
  errorMessage: z.string().max(4000).nullable().optional(),
  usage: z.unknown().optional(),
  stats: z.unknown().optional(),
});

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { jobId } = await context.params;

  try {
    const { DB } = await getBindings();
    const job = await getJob(DB, jobId);

    if (!job) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    const assets = await listJobAssets(DB, jobId);

    return NextResponse.json({
      job: {
        id: job.id,
        filename: job.source_filename,
        contentType: job.source_content_type,
        status: job.status,
        fileSize: job.file_size,
        pageCount: job.page_count,
        progress: job.progress,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        updatedAt: job.updated_at,
        errorMessage: job.error_message,
        resultUrl: job.result_json_key ? publicResultUrl(job.id) : null,
        markdownUrl: job.result_markdown_key ? `${publicResultUrl(job.id)}?format=markdown` : null,
        usage: parseJson(job.usage_json),
        stats: parseJson(job.stats_json),
      },
      assets: assets.map((asset) => ({
        id: asset.id,
        pageNumber: asset.page_number,
        questionId: asset.question_id,
        role: asset.role,
        contentType: asset.content_type,
        width: asset.width,
        height: asset.height,
        boundingBox: parseJson(asset.bounding_box_json),
        url: publicAssetUrl(job.id, asset.id),
        createdAt: asset.created_at,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Could not load job.",
        message: error instanceof Error ? error.message : "Unknown error.",
      },
      { status: 503 },
    );
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const { jobId } = await context.params;
  const parsed = updateJobSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid job update.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const { DB } = await getBindings();
    const existing = await getJob(DB, jobId);

    if (!existing) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    const status = parsed.data.status ?? existing.status;
    const timestamp = nowIso();
    const completedAt =
      status === "completed" || status === "failed" ? (existing.completed_at ?? timestamp) : existing.completed_at;

    await DB.prepare(
      `UPDATE processing_jobs
        SET status = ?, progress = ?, page_count = ?, error_message = ?,
            usage_json = COALESCE(?, usage_json),
            stats_json = COALESCE(?, stats_json),
            completed_at = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind(
        status satisfies JobStatus,
        parsed.data.progress ?? existing.progress,
        parsed.data.pageCount ?? existing.page_count,
        parsed.data.errorMessage === undefined ? existing.error_message : parsed.data.errorMessage,
        parsed.data.usage === undefined ? null : JSON.stringify(parsed.data.usage),
        parsed.data.stats === undefined ? null : JSON.stringify(parsed.data.stats),
        completedAt,
        timestamp,
        jobId,
      )
      .run();

    return NextResponse.json({ jobId, status, updatedAt: timestamp });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Could not update job.",
        message: error instanceof Error ? error.message : "Unknown error.",
      },
      { status: 503 },
    );
  }
}

function parseJson(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
