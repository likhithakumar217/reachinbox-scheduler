
import "dotenv/config";
import { Worker, Job, DelayedError } from "bullmq";
import nodemailer from "nodemailer";
import path from "path";
import fs from "fs";
import { pool } from "../db";
import { redisConnection } from "../queue";
import { notifySlack } from "../routes/slack.routes";

type SendEmailJob = {
  emailJobId: string;
};

const smtpHost = process.env.SMTP_HOST;
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;

const concurrency = Math.max(
  1,
  Number.parseInt(process.env.WORKER_CONCURRENCY || "3", 10) || 3
);

const globalHourlyLimit = Math.max(
  1,
  Number.parseInt(process.env.MAX_EMAILS_PER_HOUR || "20", 10) || 20
);

const configuredMinDelaySeconds = Math.max(
  0,
  Number.parseInt(process.env.MIN_EMAIL_DELAY_SECONDS || "2", 10) || 0
);

if (!smtpHost || !smtpUser || !smtpPass) {
  throw new Error(
    "SMTP configuration is missing. Check SMTP_HOST, SMTP_USER and SMTP_PASS."
  );
}

const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpPort === 465,
  auth: {
    user: smtpUser,
    pass: smtpPass,
  },
});

const uploadDirectory = path.resolve(process.cwd(), "uploads");
const HOUR_MS = 60 * 60 * 1000;
const REDIS_TTL_SECONDS = 48 * 60 * 60;

/**
 * Atomically reserve a send slot using Redis.
 *
 * KEYS[1]: hourly counter key prefix
 * KEYS[2]: last reserved slot key
 * KEYS[3]: reservation key for this email job
 */
const reserveSlotScript = `
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local interval = tonumber(ARGV[3])
local hourMs = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local reservation = redis.call('GET', KEYS[3])

if reservation then
  local reservedSlot, reservedWindow =
    string.match(reservation, '^(%d+):(%d+)$')

  if reservedSlot and reservedWindow then
    return {1, tonumber(reservedSlot)}
  end

  redis.call('DEL', KEYS[3])
end

local lastSlot = tonumber(redis.call('GET', KEYS[2]) or '0')
local slot = math.max(now, lastSlot + interval)

local slotWindowStart = math.floor(slot / hourMs) * hourMs
local slotWindowEnd = slotWindowStart + hourMs
local countKey = KEYS[1] .. tostring(slotWindowStart)

local count = tonumber(redis.call('GET', countKey) or '0')

if count >= limit then
  return {0, slotWindowEnd}
end

redis.call('INCR', countKey)
redis.call('EXPIRE', countKey, ttl)
redis.call('SET', KEYS[2], slot, 'EX', ttl)

redis.call(
  'SET',
  KEYS[3],
  tostring(slot) .. ':' .. tostring(slotWindowStart),
  'EX',
  ttl
)

return {1, slot}
`;

async function notifySlackRateLimit(
  senderKey: string,
  emailJobId: string,
  retryAt: number
): Promise<void> {
  // Prevent repeated notifications for the same job and sender.
  const notificationKey =
    `reachinbox:slack-rate-notice:${senderKey}:${emailJobId}`;

  const claimed = await redisConnection.set(
    notificationKey,
    "1",
    "EX",
    60 * 60,
    "NX"
  );

  if (claimed !== "OK") {
    return;
  }

  try {
    await notifySlack(
      `⚠️ ReachInbox rate limit reached for sender ${senderKey}. ` +
        `Email job ${emailJobId} has been rescheduled to ` +
        `${new Date(retryAt).toISOString()}.`
    );
  } catch (error) {
    // A Slack failure must not prevent the email from being rescheduled.
    await redisConnection.del(notificationKey).catch(() => undefined);

    console.error(
      "Slack rate-limit notification failed:",
      error instanceof Error ? error.message : error
    );
  }
}

const worker = new Worker<SendEmailJob>(
  "email-scheduler",
  async (job: Job<SendEmailJob>, token?: string) => {
    if (job.name !== "send-email") {
      throw new Error(`Unsupported job type: ${job.name}`);
    }

    const { emailJobId } = job.data;

    const result = await pool.query(
      `SELECT e.id, e.sender_id, e.recipient_email, e.subject,
              e.body, e.status, s.email AS sender_email,
              s.hourly_limit, s.min_interval_seconds
       FROM email_jobs e
       LEFT JOIN senders s ON s.id = e.sender_id
       WHERE e.id = $1`,
      [emailJobId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Email job ${emailJobId} was not found.`);
    }

    const email = result.rows[0];

    if (email.status === "sent") {
      console.log(`Email ${emailJobId} is already sent; skipping.`);
      return { skipped: true, reason: "already-sent" };
    }

    if (
      email.sender_id !== null &&
      email.sender_email?.toLowerCase() !== smtpUser.toLowerCase()
    ) {
      throw new Error(
        `Sender ${email.sender_email} does not match SMTP_USER.`
      );
    }

    const senderKey =
      email.sender_id === null ? "global" : String(email.sender_id);

    const hourlyLimit =
      email.sender_id === null
        ? globalHourlyLimit
        : Math.max(1, Number(email.hourly_limit) || globalHourlyLimit);

    const minDelaySeconds = Math.max(
      configuredMinDelaySeconds,
      Number(email.min_interval_seconds) || 0
    );

    const now = Date.now();

    const rateKeyPrefix = `reachinbox:rate:${senderKey}:`;
    const lastKey = `reachinbox:last-send:${senderKey}`;
    const reservationKey =
      `reachinbox:reservation:${senderKey}:${emailJobId}`;

    const decision = (await redisConnection.eval(
      reserveSlotScript,
      3,
      rateKeyPrefix,
      lastKey,
      reservationKey,
      now,
      hourlyLimit,
      minDelaySeconds * 1000,
      HOUR_MS,
      REDIS_TTL_SECONDS
    )) as [number | string, number | string];

    const allowed = Number(decision[0]) === 1;
    const allowedAt = Number(decision[1]);

    if (!allowed || allowedAt > Date.now() + 50) {
      const retryAt = Math.max(allowedAt, Date.now() + 1000);

      await pool.query(
        `UPDATE email_jobs
         SET status = 'scheduled', scheduled_at = $2,
             error_message = NULL
         WHERE id = $1 AND status <> 'sent'`,
        [emailJobId, new Date(retryAt).toISOString()]
      );

      await notifySlackRateLimit(senderKey, emailJobId, retryAt);

      if (!token) {
        throw new Error("BullMQ did not provide a job lock token.");
      }

      await job.moveToDelayed(retryAt, token);
      throw new DelayedError();
    }

    // Keep the hourly count charged, but remove this job's reservation.
    await redisConnection.del(reservationKey);

    const attachmentResult = await pool.query(
      `SELECT original_name, file_path, mime_type
       FROM email_attachments
       WHERE email_job_id = $1
       ORDER BY id`,
      [emailJobId]
    );

    const attachments = attachmentResult.rows.map((attachment) => {
      const filePath = path.resolve(attachment.file_path);
      const relativePath = path.relative(uploadDirectory, filePath);

      if (
        relativePath.startsWith("..") ||
        path.isAbsolute(relativePath)
      ) {
        throw new Error("Attachment path is outside the uploads directory.");
      }

      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`Attachment missing: ${attachment.original_name}`);
      }

      return {
        filename: path.basename(attachment.original_name),
        path: filePath,
        contentType: attachment.mime_type || undefined,
      };
    });

    const updateResult = await pool.query(
      `UPDATE email_jobs
       SET status = 'sending', error_message = NULL
       WHERE id = $1 AND status <> 'sent'
       RETURNING id`,
      [emailJobId]
    );

    if (updateResult.rowCount === 0) {
      console.log(`Email ${emailJobId} was already completed; skipping.`);
      return { skipped: true, reason: "already-sent" };
    }

    const info = await transporter.sendMail({
      from: smtpUser,
      to: email.recipient_email,
      subject: email.subject,
      text: email.body,
      attachments,
    });

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE email_jobs
         SET status = 'sent', sent_at = NOW(), error_message = NULL
         WHERE id = $1`,
        [emailJobId]
      );

      if (email.sender_id !== null) {
        await client.query(
          `INSERT INTO sender_email_sends (sender_id, email_job_id)
           VALUES ($1, $2)
           ON CONFLICT (email_job_id) DO NOTHING`,
          [email.sender_id, emailJobId]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    console.log(
      `Email ${emailJobId} sent successfully. ` +
        `Attachments: ${attachments.length}. Message ID: ${info.messageId}`
    );

    return {
      messageId: info.messageId,
      attachmentCount: attachments.length,
    };
  },
  {
    connection: redisConnection,
    concurrency,
  }
);

worker.on("completed", (job) => {
  console.log(`Queue job ${job.id} completed.`);
});

worker.on("failed", async (job, error) => {
  console.error(`Queue job ${job?.id} failed:`, error.message);

  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await pool
      .query(
        `UPDATE email_jobs
         SET status = 'failed', error_message = $2
         WHERE id = $1 AND status <> 'sent'`,
        [job.data.emailJobId, error.message]
      )
      .catch((dbError) => {
        console.error("Could not update failed email status:", dbError);
      });
  }
});

worker.on("error", (error) => {
  console.error("BullMQ worker error:", error);
});

console.log(
  `Email worker started. Concurrency: ${concurrency}; ` +
    `global hourly limit: ${globalHourlyLimit}; ` +
    `minimum delay: ${configuredMinDelaySeconds}s.`
);
