-- Forensic event log: every state change, automation fire, service call lands here.
-- Context columns preserve HA's causal chain so query_causal_chain can walk effects.

CREATE TABLE IF NOT EXISTS state_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  friendly_name TEXT,
  domain TEXT NOT NULL,
  old_state TEXT,
  new_state TEXT,
  attributes_json TEXT,
  fired_at_ms INTEGER NOT NULL,
  fired_at_iso TEXT NOT NULL,
  fired_at_central TEXT NOT NULL,
  context_id TEXT,
  context_parent_id TEXT,
  context_user_id TEXT,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_state_changes_entity_time ON state_changes(entity_id, fired_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_state_changes_time ON state_changes(fired_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_state_changes_domain_time ON state_changes(domain, fired_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_state_changes_context ON state_changes(context_id);
CREATE INDEX IF NOT EXISTS idx_state_changes_parent ON state_changes(context_parent_id);

CREATE TABLE IF NOT EXISTS automation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id TEXT,
  automation_name TEXT,
  fired_at_ms INTEGER NOT NULL,
  fired_at_iso TEXT NOT NULL,
  fired_at_central TEXT NOT NULL,
  trigger_entity_id TEXT,
  trigger_description TEXT,
  context_id TEXT,
  context_parent_id TEXT,
  result TEXT
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_id_time ON automation_runs(automation_id, fired_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_time ON automation_runs(fired_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_trigger ON automation_runs(trigger_entity_id, fired_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_context ON automation_runs(context_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_parent ON automation_runs(context_parent_id);

CREATE TABLE IF NOT EXISTS service_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  service TEXT NOT NULL,
  service_data_json TEXT,
  target_entity_ids TEXT,
  fired_at_ms INTEGER NOT NULL,
  fired_at_iso TEXT NOT NULL,
  fired_at_central TEXT NOT NULL,
  context_id TEXT,
  context_parent_id TEXT,
  context_user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_service_calls_time ON service_calls(fired_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_service_calls_domain_service ON service_calls(domain, service, fired_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_service_calls_context ON service_calls(context_id);
CREATE INDEX IF NOT EXISTS idx_service_calls_parent ON service_calls(context_parent_id);
