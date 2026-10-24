
import "dotenv/config";
import express from "express";
import cors from "cors";

import googleAuthRoutes from "./routes/google-auth.routes";
import slackRoutes from "./routes/slack.routes";
import attachmentRoutes from "./routes/attachment.routes";
import emailRoutes from "./routes/email.routes";
import senderRoutes from "./routes/sender.routes";

import { pool } from "./db";
import { emailQueue } from "./queue";
import { createEmailIndex } from "./elasticsearch";
import { initializeDatabaseSchema } from "./init-db-schema";

import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Bull Board configuration
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/admin/queues");

createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter,
});

// Middleware
app.use(cors());
app.use(express.json());

// API routes
app.use("/api/slack", slackRoutes);
app.use("/admin/queues", serverAdapter.getRouter());
app.use("/api/emails", emailRoutes);
app.use("/api/senders", senderRoutes);
app.use("/api/attachments", attachmentRoutes);
app.use("/api/auth/google", googleAuthRoutes);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status: "OK",
    message: "ReachInbox backend is running!",
  });
});

// PostgreSQL connection test
app.get("/api/db-test", async (_req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS database_time");

    res.json({
      status: "OK",
      message: "PostgreSQL connected successfully!",
      databaseTime: result.rows[0].database_time,
    });
  } catch (error) {
    console.error("Database connection failed:", error);

    res.status(500).json({
      status: "ERROR",
      message: "Could not connect to PostgreSQL.",
    });
  }
});

// Initialize services before starting the server
async function startServer() {
  try {
    await initializeDatabaseSchema();
    console.log("PostgreSQL database schema is ready.");

    await createEmailIndex();
    console.log("Elasticsearch emails index is ready.");

    app.listen(PORT, () => {
      console.log(`Backend server running at http://localhost:${PORT}`);
      console.log(
        `Bull Board dashboard: http://localhost:${PORT}/admin/queues`
      );
    });
  } catch (error) {
    console.error("Failed to initialize backend services:", error);
    process.exit(1);
  }
}

startServer();
