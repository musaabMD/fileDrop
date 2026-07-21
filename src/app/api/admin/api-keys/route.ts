import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiKeyRecord, requireAdmin } from "@/lib/server/api-auth";
import { getBindings } from "@/lib/server/cloudflare-bindings";

const createKeySchema = z.object({
  name: z.string().min(1).max(120),
  notes: z.string().max(1000).optional(),
});

type KeySummaryRow = {
  id: string;
  name: string;
  key_prefix: string;
  status: "active" | "revoked";
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  notes: string | null;
  call_count: number;
  job_count: number;
  failed_job_count: number;
  openrouter_cost: number | null;
  avg_duration_ms: number | null;
};

export async function GET(request: Request) {
  const unauthorized = requireAdmin(request);

  if (unauthorized) {
    return unauthorized;
  }

  try {
    const { DB } = await getBindings();
    const result = await DB.prepare<KeySummaryRow>(
      `SELECT
        api_keys.id,
        api_keys.name,
        api_keys.key_prefix,
        api_keys.status,
        api_keys.created_at,
        api_keys.last_used_at,
        api_keys.revoked_at,
        api_keys.notes,
        COUNT(api_usage_events.id) AS call_count,
        COUNT(DISTINCT processing_jobs.id) AS job_count,
        COUNT(DISTINCT CASE WHEN processing_jobs.status = 'failed' THEN processing_jobs.id END) AS failed_job_count,
        COALESCE(SUM(api_usage_events.openrouter_cost), 0) AS openrouter_cost,
        AVG(api_usage_events.duration_ms) AS avg_duration_ms
      FROM api_keys
      LEFT JOIN api_usage_events ON api_usage_events.api_key_id = api_keys.id
      LEFT JOIN processing_jobs ON processing_jobs.api_key_id = api_keys.id
      GROUP BY api_keys.id
      ORDER BY api_keys.created_at DESC`,
    ).all<KeySummaryRow>();

    return NextResponse.json({
      keys: (result.results ?? []).map((key) => ({
        id: key.id,
        name: key.name,
        keyPrefix: key.key_prefix,
        status: key.status,
        createdAt: key.created_at,
        lastUsedAt: key.last_used_at,
        revokedAt: key.revoked_at,
        notes: key.notes,
        usage: {
          calls: key.call_count,
          jobs: key.job_count,
          failedJobs: key.failed_job_count,
          openRouterCost: key.openrouter_cost ?? 0,
          avgDurationMs: key.avg_duration_ms == null ? null : Math.round(key.avg_duration_ms),
        },
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Could not list API keys.",
        message: error instanceof Error ? error.message : "Unknown error.",
      },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  const unauthorized = requireAdmin(request);

  if (unauthorized) {
    return unauthorized;
  }

  const parsed = createKeySchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid API key request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const { DB } = await getBindings();
    const key = await createApiKeyRecord(DB, parsed.data);

    return NextResponse.json(
      {
        key,
        warning: "Store this key now. It is shown only once.",
      },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: "Could not create API key.",
        message: error instanceof Error ? error.message : "Unknown error.",
      },
      { status: 503 },
    );
  }
}
