
import "dotenv/config";
import { Worker } from "bullmq";
import nodemailer from "nodemailer";
import { pool } from "../db";
import { emailQueue, redisConnection } from "../queue";
import { indexEmail } from "../email-search";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT || 587) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function updateEmailSearchIndex(emailJobId: string) {
  const result = await pool.query(
    `SELECT id, recipient_email, subject, body, status,
            scheduled_at, created_at
     FROM email_jobs
     WHERE id = $1`,
    [emailJobId]
  );

  if (result.rows.length === 0) {
    return;
  }

  const email = result.rows[0];

  await indexEmail({
    emailJobId: email.id,
    recipientEmail: email.recipient_email,
    subject: email.subject,
    body: email.body,
    status: email.status,
    scheduledAt: new Date(email.scheduled_at).toISOString(),
    createdAt: new Date(email.created_at).toISOString(),
  });
}

const worker = new Worker(
  "email-scheduler",
  async (job) => {
    const { emailJobId } = job.data as {
      emailJobId: string;
    };

    const client = await pool.connect();
    let rescheduleDelay = 0;

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `SELECT id, sender_id, recipient_email, subject, body, status
         FROM email_jobs
         WHERE id = $1
         FOR UPDATE`,
        [emailJobId]
      );

      if (result.rows.length === 0) {
        throw new Error(`Email job not found: ${emailJobId}`);
      }

      const email = result.rows[0];

      if (email.status === "sent") {
        await client.query("COMMIT");
        await updateEmailSearchIndex(emailJobId);
        console.log(`Email ${emailJobId} was already sent. Skipping.`);
        return { status: "already-sent" };
      }

      let sender = null;

      if (email.sender_id !== null) {
        const senderResult = await client.query(
          `SELECT id, email, hourly_limit, min_interval_seconds
           FROM senders
           WHERE id = $1
           FOR UPDATE`,
          [email.sender_id]
        );

        if (senderResult.rows.length === 0) {
          throw new Error(`Sender ${email.sender_id} was not found.`);
        }

        sender = senderResult.rows[0];

        const counts = await client.query(
          `SELECT
             COUNT(*)::int AS sent_last_hour,
             MAX(sent_at) AS last_sent_at
           FROM sender_email_sends
           WHERE sender_id = $1
             AND sent_at > NOW() - INTERVAL '1 hour'`,
          [sender.id]
        );

        const sentLastHour = counts.rows[0].sent_last_hour as number;
        const lastSentAt = counts.rows[0].last_sent_at
          ? new Date(counts.rows[0].last_sent_at).getTime()
          : null;

        const now = Date.now();

        if (sentLastHour >= sender.hourly_limit) {
          const oldestCountResult = await client.query(
            `SELECT sent_at
             FROM sender_email_sends
             WHERE sender_id = $1
               AND sent_at > NOW() - INTERVAL '1 hour'
             ORDER BY sent_at ASC
             OFFSET $2 LIMIT 1`,
            [sender.id, sentLastHour - sender.hourly_limit]
          );

          const nextAvailable = oldestCountResult.rows[0]?.sent_at
            ? new Date(oldestCountResult.rows[0].sent_at).getTime() +
              60 * 60 * 1000
            : now + 60 * 60 * 1000;

          rescheduleDelay = Math.max(1000, nextAvailable - now);
        } else if (
          lastSentAt !== null &&
          now - lastSentAt < sender.min_interval_seconds * 1000
        ) {
          rescheduleDelay = Math.max(
            1000,
            sender.min_interval_seconds * 1000 - (now - lastSentAt)
          );
        }

        if (rescheduleDelay > 0) {
          const rescheduleAt = new Date(Date.now() + rescheduleDelay);

          await client.query(
            `UPDATE email_jobs
             SET status = 'scheduled', scheduled_at = $2
             WHERE id = $1`,
            [emailJobId, rescheduleAt]
          );

          await client.query("COMMIT");
          await updateEmailSearchIndex(emailJobId);

          await emailQueue.add(
            "send-email",
            { emailJobId },
            {
              jobId: `retry-${emailJobId}-${Date.now()}`,
              delay: rescheduleDelay,
              attempts: 3,
              backoff: { type: "exponential", delay: 5000 },
              removeOnComplete: false,
              removeOnFail: false,
            }
          );

          console.log(
            `Rate limit reached for sender ${sender.email}. ` +
              `Email rescheduled for ${rescheduleAt.toISOString()}`
          );

          return {
            status: "rescheduled",
            scheduledAt: rescheduleAt,
          };
        }
      }

      await client.query(
        `UPDATE email_jobs
         SET status = 'sending', error_message = NULL
         WHERE id = $1`,
        [emailJobId]
      );

      const info = await transporter.sendMail({
        from: sender?.email || process.env.SMTP_USER,
        to: email.recipient_email,
        subject: email.subject,
        text: email.body,
      });

      await client.query(
        `UPDATE email_jobs
         SET status = 'sent', sent_at = NOW(), error_message = NULL
         WHERE id = $1`,
        [emailJobId]
      );

      if (sender) {
        await client.query(
          `INSERT INTO sender_email_sends (sender_id, email_job_id)
           VALUES ($1, $2)
           ON CONFLICT (email_job_id) DO NOTHING`,
          [sender.id, emailJobId]
        );
      }

      await client.query("COMMIT");

      // Update Elasticsearch with the latest status.
      await updateEmailSearchIndex(emailJobId);

      console.log(`Email sent: ${emailJobId}`);

      const previewUrl = nodemailer.getTestMessageUrl(info);

      if (previewUrl) {
        console.log(`Ethereal preview: ${previewUrl}`);
      }

      return { status: "sent" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);

      const message =
        error instanceof Error
          ? error.message
          : "Unknown email sending error";

      await pool.query(
        `UPDATE email_jobs
         SET status = 'failed', error_message = $2
         WHERE id = $1 AND status <> 'sent'`,
        [emailJobId, message]
      ).catch((dbError) => {
        console.error("Could not update email failure status:", dbError);
      });

      // Update the search index with the failure status as well.
      try {
        await updateEmailSearchIndex(emailJobId);
      } catch (indexError) {
        console.error("Could not update Elasticsearch:", indexError);
      }

      throw error;
    } finally {
      client.release();
    }
  },
  {
    connection: redisConnection,
    concurrency: 1,
  }
);

worker.on("completed", (job) => {
  console.log(`Worker completed job ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`Worker failed job ${job?.id}: ${error.message}`);
});

console.log("Email worker started");
