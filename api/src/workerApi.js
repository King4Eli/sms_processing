// Everything the worker (the device sending SMS) touches: get a worker
// token, pull the next SMS, report one as sent.
const express = require("express");
const { pool } = require("./db");
const { sha256Hex, generateToken } = require("./crypto");

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

async function workerAuth(req, res, next) {
  const [scheme, token] = (req.header("Authorization") || "").split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or malformed worker Authorization header" });
  }

  const [rows] = await pool.query(
    `SELECT id FROM worker_tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
    [sha256Hex(token)]
  );
  if (rows.length === 0) {
    return res.status(401).json({ error: "Invalid or revoked worker token" });
  }

  req.worker = { workerTokenId: rows[0].id };
  next();
}

// Self-service: get a worker token for a device name. Open, no auth.
// Registered before the /worker auth gate below so it stays unauthenticated
// despite living under the /worker prefix.
router.post("/worker/token", wrap(async (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ error: "'name' is required" });
  }

  const token = generateToken("wk");
  const [result] = await pool.query(`INSERT INTO worker_tokens (name, token_hash) VALUES (?, ?)`, [
    name,
    sha256Hex(token),
  ]);

  res.status(201).json({ id: result.insertId, name, token });
}));

router.use("/worker", workerAuth);

// Atomically claims the oldest queued SMS: status 0 -> 2.
// SELECT ... FOR UPDATE SKIP LOCKED lets concurrent workers each grab a
// different row without blocking on rows another worker already has
// locked; the WHERE status = 0 on the UPDATE guards against a race where
// the row changed between the SELECT and the UPDATE.
router.post("/worker/sms/pull", wrap(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [candidates] = await conn.query(
      `SELECT id FROM sms_queue WHERE status = 0 ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`
    );
    if (candidates.length === 0) {
      await conn.commit();
      return res.status(204).end();
    }

    const id = candidates[0].id;
    const [updateResult] = await conn.query(
      `UPDATE sms_queue SET status = 2, pulled_at = NOW(), attempts = attempts + 1
       WHERE id = ? AND status = 0`,
      [id]
    );
    if (updateResult.affectedRows === 0) {
      // Lost the race to another worker between SELECT and UPDATE.
      await conn.commit();
      return res.status(204).end();
    }

    const [rows] = await conn.query(`SELECT * FROM sms_queue WHERE id = ?`, [id]);
    await conn.commit();

    const sms = rows[0];
    res.status(200).json({ id: sms.id, to: sms.to_number, message: sms.message, status: sms.status });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

// Marks a claimed SMS as sent: status 2 -> 1. No other transition allowed.
router.patch("/worker/sms/:id/status", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid SMS id" });
  }
  if (status !== 1) {
    return res.status(400).json({ error: "Only the 2 -> 1 (processed) transition is allowed" });
  }

  const [existingRows] = await pool.query(`SELECT status FROM sms_queue WHERE id = ?`, [id]);
  if (existingRows.length === 0) {
    return res.status(404).json({ error: "SMS not found" });
  }

  const [updateResult] = await pool.query(
    `UPDATE sms_queue SET status = 1, processed_at = NOW() WHERE id = ? AND status = 2`,
    [id]
  );
  if (updateResult.affectedRows === 0) {
    return res.status(409).json({
      error: `SMS ${id} is not in a claimed (status=2) state; current status is ${existingRows[0].status}`,
    });
  }

  res.status(200).json({ id, status: 1 });
}));

module.exports = router;
