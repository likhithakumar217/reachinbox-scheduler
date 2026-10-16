 
import { Router } from "express";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "crypto";
import { WebClient } from "@slack/web-api";
import { pool } from "../db";
import { redisConnection } from "../queue";

const router = Router();

const CLIENT_ID = process.env.SLACK_CLIENT_ID;
const CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const REDIRECT_URI =
  process.env.SLACK_REDIRECT_URI ||
  "http://localhost:3000/api/slack/callback";
const FRONTEND_URL =
  process.env.FRONTEND_URL || "http://localhost:5174";

function encryptionKey(): Buffer {
  const value = process.env.SLACK_TOKEN_ENCRYPTION_KEY;

  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(
      "SLACK_TOKEN_ENCRYPTION_KEY must be a 64-character hex key."
    );
  }

  return Buffer.from(value, "hex");
}

function encryptToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);

  return [
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}

export function decryptSlackToken(value: string): string {
  const [ivHex, tagHex, encryptedHex] = value.split(":");

  if (!ivHex || !tagHex || !encryptedHex) {
    throw new Error("Invalid encrypted Slack token.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivHex, "hex")
  );

  decipher.setAuthTag(Buffer.from(tagHex, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

// Start Slack OAuth.
router.get("/connect", async (_req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).send(
      "Slack OAuth environment variables are missing."
    );
  }

  try {
    const state = randomBytes(32).toString("hex");

    await redisConnection.set(
      `slack:oauth:state:${state}`,
      "1",
      "EX",
      600
    );

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      scope: "chat:write",
      redirect_uri: REDIRECT_URI,
      state,
    });

    return res.redirect(
      `https://slack.com/oauth/v2/authorize?${params.toString()}`
    );
  } catch (error) {
    console.error("Slack OAuth start failed:", error);
    return res.status(500).send("Could not start Slack connection.");
  }
});

// Handle Slack's OAuth callback.
router.get("/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";

  try {
    const stateKey = `slack:oauth:state:${state}`;
    const validState = state
      ? await redisConnection.get(stateKey)
      : null;

    if (!validState) {
      return res.status(400).send("Invalid or expired Slack OAuth state.");
    }

    await redisConnection.del(stateKey);

    if (!code || !CLIENT_ID || !CLIENT_SECRET) {
      return res.status(400).send("Slack authorization was incomplete.");
    }

    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      }),
    });

    const data = (await response.json()) as {
      ok: boolean;
      error?: string;
      access_token?: string;
      team?: { id?: string; name?: string };
      scope?: string;
    };

    if (
      !response.ok ||
      !data.ok ||
      !data.access_token ||
      !data.team?.id
    ) {
      console.error("Slack OAuth exchange failed:", data.error);
      return res.status(400).send(
        "Slack authorization failed. Please reconnect."
      );
    }

    const encryptedToken = encryptToken(data.access_token);

    await pool.query(
      `INSERT INTO slack_connections
        (team_id, team_name, bot_access_token, scope, connected_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (team_id) DO UPDATE SET
         team_name = EXCLUDED.team_name,
         bot_access_token = EXCLUDED.bot_access_token,
         scope = EXCLUDED.scope,
         connected_at = NOW()`,
      [
        data.team.id,
        data.team.name || "Slack workspace",
        encryptedToken,
        data.scope || "chat:write",
      ]
    );

    return res.redirect(`${FRONTEND_URL}/?slack=connected`);
  } catch (error) {
    console.error("Slack OAuth callback failed:", error);
    return res.status(500).send("Could not finish Slack connection.");
  }
});

// Check connection status without exposing credentials.
router.get("/status", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT team_id, team_name, connected_at
       FROM slack_connections
       ORDER BY connected_at DESC
       LIMIT 1`
    );

    return res.json({
      connected: result.rows.length > 0,
      workspace: result.rows[0]?.team_name ?? null,
      connectedAt: result.rows[0]?.connected_at ?? null,
    });
  } catch (error) {
    console.error("Slack status check failed:", error);
    return res.status(500).json({
      error: "Could not check Slack status.",
    });
  }
});

// Disconnect the saved workspace.
router.delete("/disconnect", async (_req, res) => {
  try {
    await pool.query("DELETE FROM slack_connections");
    return res.json({ connected: false });
  } catch (error) {
    console.error("Slack disconnect failed:", error);
    return res.status(500).json({
      error: "Could not disconnect Slack.",
    });
  }
});

// Send a Slack notification using the saved workspace token.
export async function notifySlack(message: string): Promise<void> {
  const result = await pool.query(
    `SELECT bot_access_token
     FROM slack_connections
     ORDER BY connected_at DESC
     LIMIT 1`
  );

  if (!result.rows.length) {
    throw new Error("No Slack workspace is connected.");
  }

  const channel = process.env.SLACK_NOTIFICATION_CHANNEL?.trim();

  if (!channel) {
    throw new Error("SLACK_NOTIFICATION_CHANNEL is missing.");
  }

  const token = decryptSlackToken(result.rows[0].bot_access_token);
  const client = new WebClient(token);

  // Identify the workspace and bot associated with the saved token.
  const auth = await client.auth.test();

  console.log("Slack token workspace:", auth.team);
  console.log("Slack bot user ID:", auth.user_id);
  console.log("Slack target channel ID:", channel);

  // Check channel access before posting.
  const conversation = await client.conversations.info({
    channel,
  });

  console.log("Slack target channel:", conversation.channel?.name);
  console.log(
    "Slack bot is a channel member:",
    conversation.channel?.is_member
  );

  const response = await client.chat.postMessage({
    channel,
    text: message,
  });

  if (!response.ok) {
    throw new Error("Slack did not confirm the message was sent.");
  }
}

// Temporary local test endpoint; protect or remove before public deployment.
router.post("/test-notification", async (_req, res) => {
  try {
    await notifySlack(
      "✅ ReachInbox Slack notification test successful!"
    );

    return res.json({
      success: true,
      message: "Slack message sent.",
    });
  } catch (error) {
    console.error("Slack test failed:", error);

    const message =
      error instanceof Error ? error.message : String(error);

    return res.status(500).json({
      success: false,
      message,
    });
  }
});

export default router;
