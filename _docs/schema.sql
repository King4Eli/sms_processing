-- SMS Processing schema. This is the ONLY copy - the API reads and
-- executes this exact file on startup (api/src/db.js). Nothing in /api
-- duplicates or hardcodes any SQL.
--
-- Requires MySQL 8.0.16+ (enforced CHECK constraints) and 8.0.1+ (SKIP LOCKED).

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone_number VARCHAR(32) NOT NULL, -- always stored E.164-normalized, e.g. +15551234567
  country CHAR(2) NULL,              -- ISO 3166-1 alpha-2, derived from phone_number
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

ALTER TABLE users ADD COLUMN phone_number VARCHAR(32) NOT NULL DEFAULT '' AFTER email;
ALTER TABLE users ADD COLUMN country CHAR(2) NULL AFTER phone_number;

-- Customer-facing API keys. Only these may submit SMS; they may never
-- authenticate against the worker endpoints.
CREATE TABLE IF NOT EXISTS api_keys (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  key_hash CHAR(64) NOT NULL UNIQUE, -- sha256 hex digest of the plaintext key
  label VARCHAR(255) NULL,
  daily_sms_limit INT UNSIGNED NOT NULL DEFAULT 10, -- max /sms submissions per rolling 24h for this key
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMP NULL,
  CONSTRAINT fk_api_keys_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

ALTER TABLE api_keys ADD COLUMN daily_sms_limit INT UNSIGNED NOT NULL DEFAULT 10;

-- Sender identities ("workers") a customer can pick as 'from' in POST
-- /sms - admin-managed only, see admin-api.md.
CREATE TABLE IF NOT EXISTS worker_tokens (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  phone_number VARCHAR(32) NOT NULL, -- E.164-normalized "from" number this worker sends as; unique among active (non-revoked) workers, see uq_worker_tokens_active_phone_number below
  is_public TINYINT(1) NOT NULL DEFAULT 0, -- 1 = customers can see/select this number (GET /numbers, POST /sms 'from')
  token_hash CHAR(64) NOT NULL UNIQUE, -- sha256 hex digest of the plaintext token
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMP NULL,
  UNIQUE KEY uq_worker_tokens_phone_number (phone_number)
) ENGINE=InnoDB;

-- Nullable here only for pre-existing rows from before this column existed
-- (multiple NULLs are allowed under a UNIQUE index, unlike multiple '').
-- The app always validates and supplies a real value on insert. Its
-- uniqueness constraint is added further below (uq_worker_tokens_active_phone_number),
-- not here - a plain unique key on this column was tried and dropped once
-- revoked numbers started legitimately repeating.
ALTER TABLE worker_tokens ADD COLUMN phone_number VARCHAR(32) NULL AFTER name;
ALTER TABLE worker_tokens ADD COLUMN is_public TINYINT(1) NOT NULL DEFAULT 0 AFTER phone_number;

-- A revoked worker's number frees up for reuse - uniqueness should only
-- apply among active workers, not the full history. MySQL has no native
-- partial/filtered unique index, so this is done with a generated column
-- that collapses to NULL once revoked; UNIQUE indexes treat every NULL as
-- distinct, so any number of revoked rows (or one revoked + one fresh
-- active row) can now share a phone_number, while two simultaneously
-- active rows still can't. All lookups that key off phone_number already
-- filter revoked_at IS NULL (see userApi.js), so they keep resolving to
-- at most one row.
ALTER TABLE worker_tokens DROP INDEX uq_worker_tokens_phone_number;
ALTER TABLE worker_tokens ADD COLUMN active_phone_number VARCHAR(32)
  GENERATED ALWAYS AS (CASE WHEN revoked_at IS NULL THEN phone_number END) VIRTUAL
  AFTER phone_number;
ALTER TABLE worker_tokens ADD UNIQUE KEY uq_worker_tokens_active_phone_number (active_phone_number);

-- Workers are never assigned to a specific customer - 'is_public' is the
-- only visibility control (see userApi.js). This column/FK/index existed
-- briefly for that now-removed per-customer assignment; drop them for any
-- database that already applied it.
ALTER TABLE worker_tokens DROP FOREIGN KEY fk_worker_tokens_user;
ALTER TABLE worker_tokens DROP INDEX idx_worker_tokens_user;
ALTER TABLE worker_tokens DROP COLUMN user_id;

-- The worker API (pull/report SMS over a per-worker Bearer token) has
-- been removed entirely - nothing validates this credential anymore, so
-- there's no reason to keep issuing or storing one. Dropping the column
-- also drops its implicit unique index.
ALTER TABLE worker_tokens DROP COLUMN token_hash;

CREATE TABLE IF NOT EXISTS sms_queue (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  api_key_id BIGINT UNSIGNED NOT NULL,
  worker_token_id BIGINT UNSIGNED NOT NULL, -- the "from" worker picked at submission (see POST /sms in userApi.js)
  to_number VARCHAR(32) NOT NULL,
  message TEXT NOT NULL,
  status TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0=queued, 1=processed, 2=pulled',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  pulled_at TIMESTAMP NULL,
  processed_at TIMESTAMP NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  error_message TEXT NULL,
  CONSTRAINT chk_sms_queue_status CHECK (status IN (0, 1, 2)),
  CONSTRAINT fk_sms_queue_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_sms_queue_api_key FOREIGN KEY (api_key_id) REFERENCES api_keys(id),
  CONSTRAINT fk_sms_queue_worker_token FOREIGN KEY (worker_token_id) REFERENCES worker_tokens(id),
  INDEX idx_sms_queue_status_created (status, created_at)
) ENGINE=InnoDB;

-- Supports the per-API-key daily submission limit (COUNT of sms_queue rows
-- for a given api_key_id in the trailing 24h) without a separate rate
-- limit table.
ALTER TABLE sms_queue ADD INDEX idx_sms_queue_api_key_created (api_key_id, created_at);

-- Nullable for pre-existing rows (predate per-worker scoping); the app
-- always supplies a real value on insert going forward.
ALTER TABLE sms_queue ADD COLUMN worker_token_id BIGINT UNSIGNED NULL AFTER api_key_id;
ALTER TABLE sms_queue ADD CONSTRAINT fk_sms_queue_worker_token FOREIGN KEY (worker_token_id) REFERENCES worker_tokens(id);
-- Originally sized for the now-removed worker API's pull query (WHERE
-- worker_token_id = ? AND status = 0 ORDER BY created_at) - kept as-is
-- since InnoDB still needs *some* index on worker_token_id to back
-- fk_sms_queue_worker_token; not worth a migration just to shrink it.
ALTER TABLE sms_queue ADD INDEX idx_sms_queue_worker_status_created (worker_token_id, status, created_at);

-- Applies the status COMMENT to installs from before it was added (this
-- statement is idempotent - always succeeds, unlike ADD COLUMN/ADD INDEX).
ALTER TABLE sms_queue MODIFY COLUMN status TINYINT UNSIGNED NOT NULL DEFAULT 0
  COMMENT '0=queued, 1=processed, 2=pulled';
