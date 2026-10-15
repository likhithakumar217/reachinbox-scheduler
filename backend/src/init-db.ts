
import "dotenv/config";
import { pool } from "./db";

async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS senders (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        hourly_limit INTEGER NOT NULL DEFAULT 20
          CHECK (hourly_limit > 0),
        min_interval_seconds INTEGER NOT NULL DEFAULT 60
          CHECK (min_interval_seconds >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE senders
        ADD COLUMN IF NOT EXISTS hourly_limit INTEGER NOT NULL DEFAULT 20;

      ALTER TABLE senders
        ADD COLUMN IF NOT EXISTS min_interval_seconds INTEGER NOT NULL DEFAULT 60;

      CREATE TABLE IF NOT EXISTS email_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        sender_id INTEGER REFERENCES senders(id),
        recipient_email VARCHAR(255) NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        scheduled_at TIMESTAMPTZ NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'scheduled'
          CHECK (
            status IN ('scheduled', 'queued', 'sending', 'sent', 'failed')
          ),
        idempotency_key VARCHAR(255) UNIQUE,
        sent_at TIMESTAMPTZ,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sender_email_sends (
        id BIGSERIAL PRIMARY KEY,
        sender_id INTEGER NOT NULL REFERENCES senders(id),
        email_job_id UUID NOT NULL UNIQUE REFERENCES email_jobs(id),
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_email_jobs_status_scheduled
        ON email_jobs(status, scheduled_at);

      CREATE INDEX IF NOT EXISTS idx_email_jobs_sender
        ON email_jobs(sender_id);

      CREATE INDEX IF NOT EXISTS idx_sender_email_sends_sender_time
        ON sender_email_sends(sender_id, sent_at);
    `);

    console.log(
      "Database tables and sender rate-limit settings are ready!"
    );
  } catch (error) {
    console.error("Database initialization failed:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

initializeDatabase();
