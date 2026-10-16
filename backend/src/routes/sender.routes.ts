
import { Router } from "express";
import { pool } from "../db";

const router = Router();

// Get all senders
router.get("/", async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, email, hourly_limit,
             min_interval_seconds, created_at
      FROM senders
      ORDER BY id
    `);

    return res.json(result.rows);
  } catch (error) {
    console.error("Fetching senders failed:", error);
    return res.status(500).json({
      message: "Could not fetch senders.",
    });
  }
});

// Create a sender
// Update an existing sender
router.put("/:id", async (req, res) => {
  const { name, email, hourlyLimit, minIntervalSeconds } = req.body;
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ message: "Invalid sender ID." });
  }

  if (!name || !email) {
    return res.status(400).json({
      message: "Name and email are required.",
    });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const limit = Number(hourlyLimit);
  const interval = Number(minIntervalSeconds);

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    !Number.isInteger(interval) ||
    interval < 0
  ) {
    return res.status(400).json({
      message: "Please check the email, hourly limit, and minimum interval.",
    });
  }

  try {
    const result = await pool.query(
      `UPDATE senders
       SET name = $1, email = $2,
           hourly_limit = $3, min_interval_seconds = $4
       WHERE id = $5
       RETURNING id, name, email, hourly_limit, min_interval_seconds`,
      [String(name).trim(), normalizedEmail, limit, interval, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Sender not found." });
    }

    return res.json({
      message: "Sender updated successfully.",
      sender: result.rows[0],
    });
  } catch (error: any) {
    if (error.code === "23505") {
      return res.status(409).json({
        message: "A sender with this email already exists.",
      });
    }

    console.error("Updating sender failed:", error);
    return res.status(500).json({
      message: "Could not update sender.",
    });
  }
});
router.post("/", async (req, res) => {
  const { name, email, hourlyLimit, minIntervalSeconds } = req.body;

  if (!name || !email) {
    return res.status(400).json({
      message: "Name and email are required.",
    });
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({
      message: "Please provide a valid sender email.",
    });
  }

  const limit = Number(hourlyLimit ?? 20);
  const interval = Number(minIntervalSeconds ?? 60);

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    !Number.isInteger(interval) ||
    interval < 0
  ) {
    return res.status(400).json({
      message: "Hourly limit must be positive and interval cannot be negative.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO senders
        (name, email, hourly_limit, min_interval_seconds)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, name, email, hourly_limit, min_interval_seconds`,
      [String(name).trim(), normalizedEmail, limit, interval]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({
        message: "A sender with this email already exists.",
      });
    }

    return res.status(201).json({
      message: "Sender created successfully.",
      sender: result.rows[0],
    });
  } catch (error) {
    console.error("Creating sender failed:", error);
    return res.status(500).json({
      message: "Could not create sender.",
    });
  }
});

export default router;
