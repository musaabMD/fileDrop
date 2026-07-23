import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateApiKey, estimateJsonBytes, recordUsageEvent, requestByteLength } from "@/lib/server/api-auth";
import { getBindings } from "@/lib/server/cloudflare-bindings";
import { getJob, nowIso } from "@/lib/server/jobs";

const feedbackSchema = z.object({
  rating: z.enum(["like", "dislike"]),
  issue: z.string().max(120).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  qualityScore: z.number().int().min(1).max(5).nullable().optional(),
});

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const startedAt = Date.now();
  const { jobId } = await context.params;

  try {
    const { DB } = await getBindings();
    const auth = await authenticateApiKey(request, DB);

    if (auth instanceof NextResponse) {
      return auth;
    }

    const job = await getJob(DB, jobId);
    if (!job) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    const feedback = await DB.prepare(
      `SELECT job_id, api_key_id, rating, issue, notes, quality_score, created_at, updated_at
       FROM job_feedback WHERE job_id = ?`,
    )
      .bind(jobId)
      .first<Record<string, unknown>>();

    const payload = { jobId, feedback };

    await recordUsageEvent(DB, {
      apiKeyId: auth.apiKeyId ?? job.api_key_id,
      jobId,
      route: "/api/jobs/:jobId/feedback",
      method: "GET",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestBytes: requestByteLength(request),
      responseBytes: estimateJsonBytes(payload),
      meta: { authenticated: auth.authenticated },
    });

    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      { error: "Could not load feedback.", message: error instanceof Error ? error.message : "Unknown error." },
      { status: 503 },
    );
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const startedAt = Date.now();
  const { jobId } = await context.params;
  const parsed = feedbackSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid feedback payload.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const { DB } = await getBindings();
    const auth = await authenticateApiKey(request, DB);

    if (auth instanceof NextResponse) {
      return auth;
    }

    const job = await getJob(DB, jobId);
    if (!job) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    const timestamp = nowIso();
    const payload = {
      jobId,
      rating: parsed.data.rating,
      issue: parsed.data.issue ?? null,
      notes: parsed.data.notes ?? null,
      qualityScore: parsed.data.qualityScore ?? null,
      updatedAt: timestamp,
    };

    await DB.prepare(
      `INSERT INTO job_feedback (
        job_id, api_key_id, rating, issue, notes, quality_score, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        api_key_id = excluded.api_key_id,
        rating = excluded.rating,
        issue = excluded.issue,
        notes = excluded.notes,
        quality_score = excluded.quality_score,
        updated_at = excluded.updated_at`,
    )
      .bind(
        jobId,
        auth.apiKeyId ?? job.api_key_id,
        parsed.data.rating,
        parsed.data.issue ?? null,
        parsed.data.notes ?? null,
        parsed.data.qualityScore ?? null,
        timestamp,
        timestamp,
      )
      .run();

    await recordUsageEvent(DB, {
      apiKeyId: auth.apiKeyId ?? job.api_key_id,
      jobId,
      route: "/api/jobs/:jobId/feedback",
      method: "PUT",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestBytes: requestByteLength(request),
      responseBytes: estimateJsonBytes(payload),
      meta: { authenticated: auth.authenticated, rating: parsed.data.rating },
    });

    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      { error: "Could not save feedback.", message: error instanceof Error ? error.message : "Unknown error." },
      { status: 503 },
    );
  }
}
