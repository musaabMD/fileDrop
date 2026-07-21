import type { FileDropD1Database } from "@/lib/server/cloudflare-bindings";

export type JobStatus =
  | "created"
  | "uploaded"
  | "processing"
  | "completed"
  | "failed";

export type ProcessingJobRow = {
  id: string;
  source_filename: string;
  source_content_type: string | null;
  source_key: string | null;
  status: JobStatus;
  file_size: number | null;
  page_count: number | null;
  progress: number;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
  error_message: string | null;
  result_json_key: string | null;
  result_markdown_key: string | null;
  usage_json: string | null;
  stats_json: string | null;
  callback_url: string | null;
};

export type JobAssetRow = {
  id: string;
  job_id: string;
  page_number: number | null;
  question_id: string | null;
  role: string;
  key: string;
  content_type: string;
  width: number | null;
  height: number | null;
  bounding_box_json: string | null;
  created_at: string;
};

export function nowIso() {
  return new Date().toISOString();
}

export function sanitizePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "file";
}

export function jobJsonKey(jobId: string) {
  return `jobs/${jobId}/result.json`;
}

export function jobMarkdownKey(jobId: string) {
  return `jobs/${jobId}/result.md`;
}

export function jobSourceKey(jobId: string, filename: string) {
  return `jobs/${jobId}/source/${sanitizePathSegment(filename)}`;
}

export function jobAssetKey(jobId: string, assetId: string, contentType: string) {
  const extension = contentType.includes("png")
    ? "png"
    : contentType.includes("jpeg") || contentType.includes("jpg")
      ? "jpg"
      : contentType.includes("webp")
        ? "webp"
        : "bin";

  return `jobs/${jobId}/assets/${sanitizePathSegment(assetId)}.${extension}`;
}

export async function getJob(db: FileDropD1Database, jobId: string) {
  return db
    .prepare<ProcessingJobRow>("SELECT * FROM processing_jobs WHERE id = ?")
    .bind(jobId)
    .first<ProcessingJobRow>();
}

export async function listJobAssets(db: FileDropD1Database, jobId: string) {
  const result = await db
    .prepare<JobAssetRow>("SELECT * FROM job_assets WHERE job_id = ? ORDER BY page_number, created_at")
    .bind(jobId)
    .all<JobAssetRow>();

  return result.results ?? [];
}

export function publicAssetUrl(jobId: string, assetId: string) {
  return `/api/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(assetId)}`;
}

export function publicResultUrl(jobId: string) {
  return `/api/jobs/${encodeURIComponent(jobId)}/result`;
}

export function publicStatusUrl(jobId: string) {
  return `/api/jobs/${encodeURIComponent(jobId)}`;
}
