-- Story versions activated by the publisher. A version is immutable once stored.
CREATE TABLE IF NOT EXISTS stories (
  story_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  definition_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'deprecated')),
  activated_at TEXT NOT NULL,
  deprecated_at TEXT,
  PRIMARY KEY (story_id, version)
);

CREATE INDEX IF NOT EXISTS idx_stories_retention
  ON stories (status, deprecated_at);

-- Pseudonymous subjects. Only the SHA-256 of the subject secret is stored.
CREATE TABLE IF NOT EXISTS subjects (
  subject_id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('anonymous', 'named')),
  label TEXT,
  created_at TEXT NOT NULL,
  last_upload_at TEXT,
  CHECK ((mode = 'named' AND label IS NOT NULL) OR (mode = 'anonymous' AND label IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_subjects_inactive
  ON subjects (last_upload_at) WHERE last_upload_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subjects_never_uploaded
  ON subjects (created_at) WHERE last_upload_at IS NULL;

-- One snapshot per subject, story version and UTC day. First write wins.
CREATE TABLE IF NOT EXISTS snapshots (
  subject_id TEXT NOT NULL REFERENCES subjects (subject_id) ON DELETE CASCADE,
  story_id TEXT NOT NULL,
  story_version INTEGER NOT NULL,
  period TEXT NOT NULL,
  rows_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (subject_id, story_id, story_version, period)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_story_period
  ON snapshots (story_id, story_version, period);

-- SHA-256 of erased subject ids, so late uploads and re-registration are refused without keeping the id.
CREATE TABLE IF NOT EXISTS tombstones (
  subject_hash TEXT PRIMARY KEY,
  erased_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tombstones_erased
  ON tombstones (erased_at);

-- Subject-free aggregates kept after a deprecated version's subject rows are deleted.
CREATE TABLE IF NOT EXISTS story_totals (
  story_id TEXT NOT NULL,
  story_version INTEGER NOT NULL,
  period TEXT NOT NULL,
  rows_json TEXT NOT NULL,
  subject_count INTEGER NOT NULL CHECK (subject_count >= 5),
  PRIMARY KEY (story_id, story_version, period)
);
