ALTER TABLE processing_jobs ADD COLUMN api_key_id TEXT;

CREATE INDEX IF NOT EXISTS idx_processing_jobs_api_key
  ON processing_jobs(api_key_id, started_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_status_created
  ON api_keys(status, created_at);

CREATE TABLE IF NOT EXISTS api_usage_events (
  id TEXT PRIMARY KEY,
  api_key_id TEXT,
  job_id TEXT,
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  request_bytes INTEGER,
  response_bytes INTEGER,
  openrouter_cost REAL,
  meta_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL,
  FOREIGN KEY (job_id) REFERENCES processing_jobs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_api_usage_events_key_created
  ON api_usage_events(api_key_id, created_at);

CREATE INDEX IF NOT EXISTS idx_api_usage_events_job_created
  ON api_usage_events(job_id, created_at);
