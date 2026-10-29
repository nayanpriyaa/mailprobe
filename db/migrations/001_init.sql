-- MySQL 8.0.19+ (row-alias upserts). utf8mb4 everywhere; addresses are ASCII after
-- normalization but raw CSV input may not be.

CREATE TABLE accounts (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email       VARCHAR(254)    NOT NULL,
  name        VARCHAR(120)    NULL,
  -- Prepaid verification credits. Debited atomically with a guarded UPDATE
  -- (credits >= cost) so concurrent uploads can never overdraw.
  credits     INT UNSIGNED    NOT NULL DEFAULT 1000,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_accounts_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE api_keys (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id    BIGINT UNSIGNED NOT NULL,
  name          VARCHAR(80)     NOT NULL,
  -- First characters of the key, shown in the dashboard so users can tell keys apart.
  prefix        CHAR(16)        NOT NULL,
  -- SHA-256 of the full key. The plaintext is shown once at creation and never stored.
  -- A fast hash is fine here (unlike passwords): keys are 190 bits of randomness.
  key_hash      BINARY(32)      NOT NULL,
  last_used_at  DATETIME(3)     NULL,
  revoked_at    DATETIME(3)     NULL,
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_api_keys_hash (key_hash),
  KEY ix_api_keys_account (account_id),
  CONSTRAINT fk_api_keys_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE jobs (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- ULID exposed through the API. Sequential ids would leak platform volume and
  -- invite enumeration; ULIDs are still time-ordered for humans reading logs.
  public_id           CHAR(26)        NOT NULL,
  account_id          BIGINT UNSIGNED NOT NULL,
  name                VARCHAR(255)    NULL,
  status              ENUM('queued','processing','completed','failed') NOT NULL DEFAULT 'queued',
  total               INT UNSIGNED    NOT NULL,
  processed           INT UNSIGNED    NOT NULL DEFAULT 0,
  deliverable         INT UNSIGNED    NOT NULL DEFAULT 0,
  undeliverable       INT UNSIGNED    NOT NULL DEFAULT 0,
  risky               INT UNSIGNED    NOT NULL DEFAULT 0,
  unknown             INT UNSIGNED    NOT NULL DEFAULT 0,
  duplicates_removed  INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at          DATETIME(3)     NULL,
  completed_at        DATETIME(3)     NULL,
  -- Bumped by every counter update; the reconciler treats a queued/processing job
  -- with no progress for a while as stuck and re-enqueues its unfinished rows.
  updated_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_jobs_public_id (public_id),
  -- Dashboard lists an account's jobs newest first with keyset pagination on id.
  KEY ix_jobs_account_id (account_id, id),
  -- Reconciler: WHERE status IN ('queued','processing') AND updated_at < ?
  KEY ix_jobs_status_updated (status, updated_at),
  CONSTRAINT fk_jobs_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE verifications (
  id             BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  account_id     BIGINT UNSIGNED  NOT NULL,
  -- NULL for single synchronous /v1/verify calls.
  job_id         BIGINT UNSIGNED  NULL,
  -- Normalized address when the syntax was valid, otherwise the raw input.
  email          VARCHAR(320)     NOT NULL,
  domain         VARCHAR(253)     NULL,
  -- Lifecycle, independent of the verdict: pending -> (retry ->)* done.
  -- Workers only ever move rows forward from pending/retry, which makes chunk
  -- processing idempotent under BullMQ's at-least-once delivery.
  state          ENUM('pending','retry','done') NOT NULL DEFAULT 'pending',
  status         ENUM('deliverable','undeliverable','risky','unknown') NULL,
  reason         VARCHAR(32)      NULL,
  score          TINYINT UNSIGNED NULL,
  attempts       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  is_disposable  BOOLEAN          NOT NULL DEFAULT FALSE,
  is_role        BOOLEAN          NOT NULL DEFAULT FALSE,
  is_free        BOOLEAN          NOT NULL DEFAULT FALSE,
  is_catch_all   BOOLEAN          NULL,
  mx_host        VARCHAR(253)     NULL,
  smtp_code      SMALLINT UNSIGNED NULL,
  smtp_message   VARCHAR(500)     NULL,
  suggestion     VARCHAR(253)     NULL,
  created_at     DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  verified_at    DATETIME(3)      NULL,
  -- When a row in state 'retry' is due; lets the reconciler recover lost delayed jobs.
  retry_at       DATETIME(3)      NULL,
  PRIMARY KEY (id),
  -- Dedup within a job; also rejects double inserts if an upload request is retried.
  UNIQUE KEY uq_verifications_job_email (job_id, email),
  -- Keyset pagination of a job's results and the worker's chunk scan (job_id, id range).
  KEY ix_verifications_job_id (job_id, id),
  -- Results filtered by verdict ("export only deliverable"), still keyset-paginated.
  KEY ix_verifications_job_status_id (job_id, status, id),
  -- Account history for single verifications.
  KEY ix_verifications_account_created (account_id, created_at),
  CONSTRAINT fk_verifications_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
  CONSTRAINT fk_verifications_job FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Pre-aggregated usage so the dashboard chart reads <= 90 rows instead of
-- COUNT(*)-ing millions of verifications. Maintained with an upsert per chunk.
CREATE TABLE usage_daily (
  account_id     BIGINT UNSIGNED NOT NULL,
  day            DATE            NOT NULL,
  verifications  INT UNSIGNED    NOT NULL DEFAULT 0,
  deliverable    INT UNSIGNED    NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day),
  CONSTRAINT fk_usage_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
