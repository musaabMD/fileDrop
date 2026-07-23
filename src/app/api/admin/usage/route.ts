import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/api-auth";
import { getBindings } from "@/lib/server/cloudflare-bindings";

type TotalsRow = {
  calls: number;
  jobs: number;
  failures: number;
  failed_jobs: number;
  openrouter_cost: number | null;
  avg_duration_ms: number | null;
};

type DailyRow = {
  day: string;
  calls: number;
  jobs: number;
  failures: number;
  openrouter_cost: number | null;
};

type RouteRow = {
  route: string;
  method: string;
  calls: number;
  failures: number;
  openrouter_cost: number | null;
  avg_duration_ms: number | null;
};

type FeedbackTotalsRow = {
  total: number;
  likes: number;
  dislikes: number;
  average_quality: number | null;
};

type FeedbackRow = {
  job_id: string;
  source_filename: string | null;
  rating: "like" | "dislike";
  issue: string | null;
  notes: string | null;
  quality_score: number | null;
  created_at: string;
  updated_at: string;
};

type LastSessionRow = {
  id: string;
  api_key_id: string | null;
  job_id: string | null;
  route: string;
  method: string;
  status_code: number;
  duration_ms: number;
  request_bytes: number | null;
  response_bytes: number | null;
  openrouter_cost: number | null;
  created_at: string;
  source_filename: string | null;
};

export async function GET(request: Request) {
  const unauthorized = requireAdmin(request);

  if (unauthorized) {
    return unauthorized;
  }

  try {
    const { DB } = await getBindings();
    const totals = await DB.prepare<TotalsRow>(
      `SELECT
        COUNT(*) AS calls,
        COUNT(DISTINCT job_id) AS jobs,
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS failures,
        (SELECT COUNT(*) FROM processing_jobs WHERE status = 'failed') AS failed_jobs,
        COALESCE(SUM(openrouter_cost), 0) AS openrouter_cost,
        AVG(duration_ms) AS avg_duration_ms
      FROM api_usage_events`,
    ).first<TotalsRow>();
    const daily = await DB.prepare<DailyRow>(
      `SELECT
        substr(created_at, 1, 10) AS day,
        COUNT(*) AS calls,
        COUNT(DISTINCT job_id) AS jobs,
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS failures,
        COALESCE(SUM(openrouter_cost), 0) AS openrouter_cost
      FROM api_usage_events
      GROUP BY day
      ORDER BY day DESC
      LIMIT 30`,
    ).all<DailyRow>();
    const routes = await DB.prepare<RouteRow>(
      `SELECT
        route,
        method,
        COUNT(*) AS calls,
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS failures,
        COALESCE(SUM(openrouter_cost), 0) AS openrouter_cost,
        AVG(duration_ms) AS avg_duration_ms
      FROM api_usage_events
      GROUP BY route, method
      ORDER BY calls DESC
      LIMIT 50`,
    ).all<RouteRow>();
    const feedbackTotals = await DB.prepare<FeedbackTotalsRow>(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN rating = 'like' THEN 1 ELSE 0 END) AS likes,
        SUM(CASE WHEN rating = 'dislike' THEN 1 ELSE 0 END) AS dislikes,
        AVG(quality_score) AS average_quality
      FROM job_feedback`,
    ).first<FeedbackTotalsRow>();
    const feedback = await DB.prepare<FeedbackRow>(
      `SELECT
        job_feedback.job_id,
        processing_jobs.source_filename,
        job_feedback.rating,
        job_feedback.issue,
        job_feedback.notes,
        job_feedback.quality_score,
        job_feedback.created_at,
        job_feedback.updated_at
      FROM job_feedback
      LEFT JOIN processing_jobs ON processing_jobs.id = job_feedback.job_id
      ORDER BY job_feedback.updated_at DESC
      LIMIT 20`,
    ).all<FeedbackRow>();
    const lastSession = await DB.prepare<LastSessionRow>(
      `SELECT
        api_usage_events.id,
        api_usage_events.api_key_id,
        api_usage_events.job_id,
        api_usage_events.route,
        api_usage_events.method,
        api_usage_events.status_code,
        api_usage_events.duration_ms,
        api_usage_events.request_bytes,
        api_usage_events.response_bytes,
        api_usage_events.openrouter_cost,
        api_usage_events.created_at,
        processing_jobs.source_filename
      FROM api_usage_events
      LEFT JOIN processing_jobs ON processing_jobs.id = api_usage_events.job_id
      ORDER BY api_usage_events.created_at DESC
      LIMIT 1`,
    ).first<LastSessionRow>();

    return NextResponse.json({
      totals: {
        calls: totals?.calls ?? 0,
        jobs: totals?.jobs ?? 0,
        failures: (totals?.failures ?? 0) + (totals?.failed_jobs ?? 0),
        failedJobs: totals?.failed_jobs ?? 0,
        openRouterCost: totals?.openrouter_cost ?? 0,
        avgDurationMs: totals?.avg_duration_ms == null ? null : Math.round(totals.avg_duration_ms),
      },
      daily: (daily.results ?? []).map((row) => ({
        day: row.day,
        calls: row.calls,
        jobs: row.jobs,
        failures: row.failures,
        openRouterCost: row.openrouter_cost ?? 0,
      })),
      routes: (routes.results ?? []).map((row) => ({
        route: row.route,
        method: row.method,
        calls: row.calls,
        failures: row.failures,
        openRouterCost: row.openrouter_cost ?? 0,
        avgDurationMs: row.avg_duration_ms == null ? null : Math.round(row.avg_duration_ms),
      })),
      feedback: {
        totals: {
          total: feedbackTotals?.total ?? 0,
          likes: feedbackTotals?.likes ?? 0,
          dislikes: feedbackTotals?.dislikes ?? 0,
          averageQuality: feedbackTotals?.average_quality == null ? null : Math.round(feedbackTotals.average_quality * 10) / 10,
        },
        recent: (feedback.results ?? []).map((row) => ({
          jobId: row.job_id,
          sourceFilename: row.source_filename,
          rating: row.rating,
          issue: row.issue,
          notes: row.notes,
          qualityScore: row.quality_score,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      },
      lastSession: lastSession
        ? {
            id: lastSession.id,
            apiKeyId: lastSession.api_key_id,
            jobId: lastSession.job_id,
            sourceFilename: lastSession.source_filename,
            route: lastSession.route,
            method: lastSession.method,
            statusCode: lastSession.status_code,
            durationMs: lastSession.duration_ms,
            requestBytes: lastSession.request_bytes,
            responseBytes: lastSession.response_bytes,
            openRouterCost: lastSession.openrouter_cost ?? 0,
            createdAt: lastSession.created_at,
          }
        : null,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Could not load usage.",
        message: error instanceof Error ? error.message : "Unknown error.",
      },
      { status: 503 },
    );
  }
}
