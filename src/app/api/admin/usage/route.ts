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
