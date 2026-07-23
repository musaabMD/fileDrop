ALTER TABLE processing_jobs ADD COLUMN source_fingerprint TEXT;
ALTER TABLE processing_jobs ADD COLUMN source_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_processing_jobs_fingerprint
  ON processing_jobs(source_hash, file_size, page_count, source_filename);
