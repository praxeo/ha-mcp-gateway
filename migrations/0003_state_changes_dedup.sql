-- Remove existing duplicate rows before creating the unique index.
-- Keeps the lowest rowid (earliest insert) for each (entity_id, fired_at_ms, new_state) triple.
DELETE FROM state_changes WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM state_changes GROUP BY entity_id, fired_at_ms, new_state
);

-- Prevent future duplicates from WS / backfill race on reconnect.
-- D1 doesn't support ALTER TABLE ADD CONSTRAINT UNIQUE; a unique index
-- is the equivalent and enables INSERT OR IGNORE deduplication.
CREATE UNIQUE INDEX IF NOT EXISTS idx_state_changes_dedup
  ON state_changes(entity_id, fired_at_ms, new_state);
