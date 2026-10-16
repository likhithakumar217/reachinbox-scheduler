
import { searchEmails, indexEmail } from "../email-search";
import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { emailQueue } from "../queue";
import fs from "fs";
import path from "path";

const router = Router();

const uploadDirectory = path.resolve(process.cwd(), "uploads");

type AttachmentInput = {
  storedName: string;
  originalName: string;
  mimeType: string;
  fileSize: number;
};

router.get("/search", async (req, res) => {
  try {
    const query = String(req.query.q ?? "").trim();

    if (!query) {
      return res.status(400).json({
        error: "Search query is required. Use ?q=your-search-term",
      });
    }

    const results = await searchEmails(query);
    return res.json({ count: results.length, results });
  } catch (error) {
    console.error("Email search failed:", error);
    return res.status(500).json({
      error: "Email search failed. Check Elasticsearch is running.",
    });
  }
});

async function queueEmail(
  req: Request,
  res: Response,
  sendNow: boolean
) {
  const { senderId, recipientEmail, subject, body } = req.body;
  const scheduledAt = sendNow
    ? new Date().toISOString()
    : req.body.scheduledAt;

  if (
    !recipientEmail ||
    !subject ||
    !body ||
    !scheduledAt ||
    Number.isNaN(Date.parse(scheduledAt))
  ) {
    return res.status(400).json({
      message:
        "Valid recipientEmail, subject, body, and scheduledAt are required.",
    });
  }

  if (!sendNow && Date.parse(scheduledAt) < Date.now()) {
    return res.status(400).json({
      message: "Scheduled time must be in the future.",
    });
  }

  const recipient = String(recipientEmail).trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return res.status(400).json({
      message: "Invalid recipient email.",
    });
  }

  const attachments: AttachmentInput[] = req.body.attachments ?? [];

  if (!Array.isArray(attachments) || attachments.length > 5) {
    return res.status(400).json({
      message: "You can attach up to 5 files per email.",
    });
  }

  // Verify every uploaded file exists inside the uploads folder.
  const verifiedAttachments: Array<{
    originalName: string;
    storedName: string;
    filePath: string;
    mimeType: string;
    fileSize: number;
  }> = [];

  for (const attachment of attachments) {
    if (
      !attachment ||
      typeof attachment.storedName !== "string" ||
      path.basename(attachment.storedName) !== attachment.storedName ||
      !/^\d+-[0-9a-f-]+\.(jpg|jpeg|png|gif|webp|pdf|doc|docx)$/i.test(
        attachment.storedName
      )
    ) {
      return res.status(400).json({
        message: "Invalid attachment reference. Please upload the file again.",
      });
    }

    const filePath = path.join(uploadDirectory, attachment.storedName);

    try {
      const stat = await fs.promises.stat(filePath);

      if (!stat.isFile() || stat.size > 10 * 1024 * 1024) {
        return res.status(400).json({
          message: "An attachment is missing or exceeds the 10 MB limit.",
        });
      }

      verifiedAttachments.push({
        originalName:
          typeof attachment.originalName === "string"
            ? path.basename(attachment.originalName).slice(0, 255)
            : attachment.storedName,
        storedName: attachment.storedName,
        filePath,
        mimeType:
          typeof attachment.mimeType === "string"
            ? attachment.mimeType
            : "application/octet-stream",
        fileSize: stat.size,
      });
    } catch {
      return res.status(400).json({
        message: "An attachment was not found. Please upload it again.",
      });
    }
  }

  const idempotencyKey = req.get("Idempotency-Key") || randomUUID();
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

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

    if (inserted.rows.length === 0) {
      const existing = await client.query(
        "SELECT id FROM email_jobs WHERE idempotency_key = $1",
        [idempotencyKey]
      );

      await client.query("COMMIT");
      transactionOpen = false;

      return res.status(200).json({
        message: "This request was already queued.",
        emailJobId: existing.rows[0].id,
      });
    }

    const emailJobId: string = inserted.rows[0].id;

    for (const attachment of verifiedAttachments) {
      await client.query(
        `INSERT INTO email_attachments
          (email_job_id, original_name, stored_name, file_path, mime_type, file_size)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          emailJobId,
          attachment.originalName,
          attachment.storedName,
          attachment.filePath,
          attachment.mimeType,
          attachment.fileSize,
        ]
      );
    }

    await indexEmail({
      emailJobId,
      recipientEmail: recipient,
      subject: String(subject),
      body: String(body),
      status: "scheduled",
      scheduledAt: new Date(scheduledAt).toISOString(),
      createdAt: new Date().toISOString(),
    });

    await emailQueue.add(
      "send-email",
      { emailJobId },
      {
        jobId: emailJobId,
        delay: sendNow
          ? 0
          : Math.max(0, Date.parse(scheduledAt) - Date.now()),
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: false,
        removeOnFail: false,
      }
    );

    await client.query("COMMIT");
    transactionOpen = false;

    return res.status(201).json({
      message: sendNow
        ? "Email queued for immediate sending."
        : "Email scheduled successfully.",
      emailJobId,
      attachmentCount: verifiedAttachments.length,
    });
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => undefined);
    }

    console.error(sendNow ? "Send Now failed:" : "Scheduling failed:", error);

    return res.status(500).json({
      message: sendNow
        ? "Could not queue the email for sending."
        : "Could not schedule the email.",
    });
  } finally {
    client.release();
  }
}

router.post("/send-now", async (req, res) => {
  return queueEmail(req, res, true);
});

router.post("/schedule", async (req, res) => {
  return queueEmail(req, res, false);
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
    return res.status(500).json({
      message: "Could not fetch emails.",
    });
  }
});

export default router;
