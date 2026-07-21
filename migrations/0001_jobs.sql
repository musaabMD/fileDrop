CREATE TABLE IF NOT EXISTS processing_jobs (
  id TEXT PRIMARY KEY,
  source_filename TEXT NOT NULL,
  source_content_type TEXT,
  source_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('created', 'uploaded', 'processing', 'completed', 'failed')),
  file_size INTEGER,
  page_count INTEGER,
  progress INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  error_message TEXT,
  result_json_key TEXT,
  result_markdown_key TEXT,
  usage_json TEXT,
  stats_json TEXT,
  callback_url TEXT
);

CREATE INDEX IF NOT EXISTS idx_processing_jobs_status_updated
  ON processing_jobs(status, updated_at);

CREATE TABLE IF NOT EXISTS job_assets (
  id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  page_number INTEGER,
  question_id TEXT,
  role TEXT NOT NULL,
  key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  bounding_box_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, id),
  FOREIGN KEY (job_id) REFERENCES processing_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_assets_job_page
  ON job_assets(job_id, page_number);

CREATE TABLE IF NOT EXISTS job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES processing_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_events_job_created
  ON job_events(job_id, created_at);
