
import "dotenv/config";
import { pool } from "./db";
import { indexEmail } from "./email-search";
import { elasticsearchClient } from "./elasticsearch";

async function syncEmailIndex() {
  try {
    const result = await pool.query(`
      SELECT
        id,
        recipient_email,
        subject,
        body,
        status,
        scheduled_at,
        created_at
      FROM email_jobs
      ORDER BY created_at ASC
    `);

    for (const email of result.rows) {
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

    console.log(
      `Successfully indexed ${result.rows.length} email jobs.`
    );
  } catch (error) {
    console.error("Failed to synchronize email index:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
    await elasticsearchClient.close();
  }
}

syncEmailIndex();
