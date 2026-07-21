import { NextResponse } from "next/server";
import { authenticateApiKey, recordUsageEvent, requestByteLength } from "@/lib/server/api-auth";
import { getBindings } from "@/lib/server/cloudflare-bindings";
import { getJob, publicAssetUrl } from "@/lib/server/jobs";

type RouteContext = {
  params: Promise<{ jobId: string; assetId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const startedAt = Date.now();
  const { jobId, assetId } = await context.params;

  try {
    const { DB, FILES } = await getBindings();
    const auth = await authenticateApiKey(_request, DB);

    if (auth instanceof NextResponse) {
      return auth;
    }

    const job = await getJob(DB, jobId);

    if (!job) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    const asset = await DB.prepare<{ key: string; content_type: string }>(
      "SELECT key, content_type FROM job_assets WHERE job_id = ? AND id = ?",
    )
      .bind(jobId, assetId)
      .first<{ key: string; content_type: string }>();

    if (!asset) {
      return NextResponse.json({ error: "Asset not found." }, { status: 404 });
    }

    const object = await FILES.get(asset.key);

    if (!object) {
      return NextResponse.json({ error: "Stored asset missing." }, { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata?.(headers);
    headers.set("content-type", headers.get("content-type") ?? asset.content_type);
    headers.set("cache-control", "private, max-age=3600");
    headers.set("link", `<${publicAssetUrl(jobId, assetId)}>; rel="self"`);

    await recordUsageEvent(DB, {
      apiKeyId: auth.apiKeyId ?? job.api_key_id,
      jobId,
      route: "/api/jobs/:jobId/assets/:assetId",
      method: "GET",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestBytes: requestByteLength(_request),
      responseBytes: null,
      meta: { authenticated: auth.authenticated, assetId },
    });

    return new Response(object.body, { headers });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Could not load asset.",
        message: error instanceof Error ? error.message : "Unknown error.",
      },
      { status: 503 },
    );
  }
}
