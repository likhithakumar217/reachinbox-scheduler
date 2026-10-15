import { searchEmails } from "../email-search";
import { indexEmail } from "../email-search";
import { Router } from "express";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { emailQueue } from "../queue";

const router = Router();

router.get("/search", async (req, res) => {
  try {
    const query = String(req.query.q ?? "").trim();

    if (!query) {
      return res.status(400).json({
        error: "Search query is required. Use ?q=your-search-term",
      });
    }

    const results = await searchEmails(query);

    return res.json({
      count: results.length,
      results,
    });
  } catch (error) {
    console.error("Email search failed:", error);

    return res.status(500).json({
      error: "Email search failed. Check Elasticsearch is running.",
    });
  }
});
router.post("/schedule", async (req, res) => {
  const {
    senderId,
    recipientEmail,
    subject,
    body,
    scheduledAt,
  } = req.body;

  if (
    !recipientEmail ||
    !subject ||
    !body ||
    !scheduledAt ||
    Number.isNaN(Date.parse(scheduledAt))
  ) {
    return res.status(400).json({
      message: "Valid recipientEmail, subject, body, and scheduledAt are required.",
    });
  }

  const recipient = String(recipientEmail).trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return res.status(400).json({ message: "Invalid recipient email." });
  }

  const idempotencyKey =
    req.get("Idempotency-Key") || randomUUID();

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const inserted = await client.query(
      `INSERT INTO email_jobs
        (sender_id, recipient_email, subject, body, scheduled_at, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        senderId ?? null,
        recipient,
        String(subject),
        String(body),
        scheduledAt,
        idempotencyKey,
      ]
    );

    let emailJobId: string;

    if (inserted.rows.length === 0) {
      const existing = await client.query(
        "SELECT id FROM email_jobs WHERE idempotency_key = $1",
        [idempotencyKey]
      );

      emailJobId = existing.rows[0].id;
      await client.query("COMMIT");

      return res.status(200).json({
        message: "This request was already scheduled.",
        emailJobId,
      });
    }

    emailJobId = inserted.rows[0].id;

    await indexEmail({
      emailJobId,
      recipientEmail: recipient,
      subject: String(subject),
      body: String(body),
      status: "scheduled",
      scheduledAt: new Date(scheduledAt).toISOString(),
      createdAt: new Date().toISOString(),
    });

    const delay = Math.max(
      0,
      Date.parse(scheduledAt) - Date.now()
    );

    await emailQueue.add(
      "send-email",
      { emailJobId },
      {
        jobId: emailJobId,
        delay,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: false,
        removeOnFail: false,
      }
    );

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Email scheduled successfully.",
      emailJobId,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Scheduling failed:", error);

    return res.status(500).json({
      message: "Could not schedule the email.",
    });
  } finally {
    client.release();
  }
});

router.get("/", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, sender_id, recipient_email, subject,
              scheduled_at, status, sent_at, created_at
       FROM email_jobs
       ORDER BY scheduled_at DESC
       LIMIT 100`
    );

    return res.json(result.rows);
  } catch (error) {
    console.error("Fetching emails failed:", error);
    return res.status(500).json({ message: "Could not fetch emails." });
  }
});

export default router;
