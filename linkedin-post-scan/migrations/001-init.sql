PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETE','FAILED','STOPPED')),
  stop_code TEXT,
  coverage_json TEXT NOT NULL DEFAULT '{}',
  receipt_json TEXT
);

CREATE UNIQUE INDEX one_active_run ON runs(status) WHERE status = 'RUNNING';

CREATE TABLE query_runs (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  query_key TEXT NOT NULL,
  priority TEXT NOT NULL,
  query_text TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  elapsed_ms INTEGER,
  posts_verified INTEGER NOT NULL DEFAULT 0,
  past_week_verified INTEGER NOT NULL DEFAULT 0,
  latest_selected INTEGER,
  result_count INTEGER NOT NULL DEFAULT 0,
  deep_check_count INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, query_key)
);

CREATE TABLE posts (
  post_urn TEXT PRIMARY KEY,
  post_url TEXT NOT NULL,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  author_json TEXT NOT NULL DEFAULT '{}',
  published_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  route TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE run_posts (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  query_key TEXT NOT NULL,
  post_urn TEXT NOT NULL,
  body_hash TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (run_id, query_key, post_urn)
);

CREATE TABLE opportunities (
  opportunity_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('EXACT_JOB','CONTACT','REVIEW')),
  posting_key TEXT UNIQUE,
  employer TEXT,
  title TEXT,
  location TEXT,
  official_url TEXT,
  post_signal REAL,
  status TEXT NOT NULL,
  reason_code TEXT,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE post_opportunities (
  post_urn TEXT NOT NULL REFERENCES posts(post_urn),
  opportunity_id TEXT NOT NULL REFERENCES opportunities(opportunity_id),
  PRIMARY KEY (post_urn, opportunity_id)
);

CREATE TABLE contacts (
  contact_id TEXT PRIMARY KEY,
  member_id TEXT UNIQUE,
  profile_url TEXT UNIQUE,
  name TEXT,
  company TEXT,
  title TEXT,
  relationship_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  verified_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE outreach (
  outreach_id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(contact_id),
  opportunity_id TEXT NOT NULL REFERENCES opportunities(opportunity_id),
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  draft TEXT NOT NULL,
  prepared_at TEXT,
  last_checked_at TEXT,
  visible_result TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (contact_id, opportunity_id)
);

CREATE TABLE career_ops_handoffs (
  posting_key TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(opportunity_id),
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reason_code TEXT,
  report_identity TEXT,
  tracker_identity TEXT,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE exclusion_tombstones (
  post_id_hash TEXT PRIMARY KEY,
  reason_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

PRAGMA user_version = 1;
