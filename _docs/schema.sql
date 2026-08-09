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

-- Separate credential space for workers (the devices sending SMS).
-- Deliberately not shared with api_keys so a leaked customer key can never
-- pull or complete queue items.
CREATE TABLE IF NOT EXISTS worker_tokens (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE, -- sha256 hex digest of the plaintext token
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMP NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sms_queue (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  api_key_id BIGINT UNSIGNED NOT NULL,
  to_number VARCHAR(32) NOT NULL,
  message TEXT NOT NULL,
  status TINYINT UNSIGNED NOT NULL DEFAULT 0, -- 0=queued, 1=processed, 2=pulled
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  pulled_at TIMESTAMP NULL,
  processed_at TIMESTAMP NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  error_message TEXT NULL,
  CONSTRAINT chk_sms_queue_status CHECK (status IN (0, 1, 2)),
  CONSTRAINT fk_sms_queue_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_sms_queue_api_key FOREIGN KEY (api_key_id) REFERENCES api_keys(id),
  INDEX idx_sms_queue_status_created (status, created_at)
) ENGINE=InnoDB;

-- Supports the per-API-key daily submission limit (COUNT of sms_queue rows
-- for a given api_key_id in the trailing 24h) without a separate rate
-- limit table.
ALTER TABLE sms_queue ADD INDEX idx_sms_queue_api_key_created (api_key_id, created_at);
