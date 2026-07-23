CREATE TABLE IF NOT EXISTS job_feedback (
  job_id TEXT PRIMARY KEY,
  api_key_id TEXT,
  rating TEXT NOT NULL CHECK (rating IN ('like', 'dislike')),
  issue TEXT,
  notes TEXT,
  quality_score INTEGER CHECK (quality_score BETWEEN 1 AND 5),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES processing_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_job_feedback_api_key_created
  ON job_feedback(api_key_id, created_at);

CREATE INDEX IF NOT EXISTS idx_job_feedback_created_at
  ON job_feedback(created_at);
