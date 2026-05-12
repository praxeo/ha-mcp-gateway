-- Indexes for the existing tables
CREATE INDEX IF NOT EXISTS idx_ai_log_timestamp     ON ai_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_ai_log_type          ON ai_log(type);
CREATE INDEX IF NOT EXISTS idx_observations_timestamp ON observations(timestamp);
CREATE INDEX IF NOT EXISTS idx_bugs_severity_ts     ON bugs(severity, timestamp_iso);

-- Optional JSON payload column on observations (nullable; not populated in this dispatch).
ALTER TABLE observations ADD COLUMN data TEXT;
