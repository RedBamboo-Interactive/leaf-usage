-- Stories are edited in place. Every previous definition is kept here when an activation replaces
-- it: a read-only record that no behaviour depends on.
CREATE TABLE IF NOT EXISTS story_definitions_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  shape_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_story_history_story
  ON story_definitions_history (story_id, changed_at);

-- SHA-256 of the story's data shape when the snapshot was accepted (NULL for rows accepted before
-- this migration), so each answer row can be tied to the definition it was produced under.
ALTER TABLE snapshots ADD COLUMN shape_hash TEXT;
