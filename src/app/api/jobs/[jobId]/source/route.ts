import { NextResponse } from "next/server";
import { getBindings } from "@/lib/server/cloudflare-bindings";
import { getJob, jobSourceKey, nowIso } from "@/lib/server/jobs";

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

export async function PUT(request: Request, context: RouteContext) {
  const { jobId } = await context.params;

  try {
    const { DB, FILES } = await getBindings();
    const job = await getJob(DB, jobId);

    if (!job) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    const contentType = request.headers.get("content-type") ?? job.source_content_type ?? "application/octet-stream";
    const body = await request.arrayBuffer();
    const key = jobSourceKey(jobId, job.source_filename);
    const timestamp = nowIso();

    await FILES.put(key, body, { httpMetadata: { contentType } });
    await DB.prepare(
      `UPDATE processing_jobs
        SET source_key = ?, source_content_type = ?, file_size = ?, status = ?, progress = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind(key, contentType, body.byteLength, "uploaded", Math.max(job.progress, 5), timestamp, jobId)
      .run();

    return NextResponse.json({ jobId, status: "uploaded", sourceKey: key, bytes: body.byteLength });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Could not upload source file.",
        message: error instanceof Error ? error.message : "Unknown error.",
      },
      { status: 503 },
    );
  }
}
