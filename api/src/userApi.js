// Everything a customer/website touches: get an API key, submit an SMS.
const express = require("express");
const { pool } = require("./db");
const { sha256Hex, generateToken } = require("./crypto");

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const DAILY_SMS_LIMIT_PER_API_KEY = 10;

async function customerAuth(req, res, next) {
  const apiKey = req.header("X-Api-Key");
  if (!apiKey) {
    return res.status(401).json({ error: "Missing X-Api-Key header" });
  }

  const [rows] = await pool.query(
    `SELECT id, user_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL LIMIT 1`,
    [sha256Hex(apiKey)]
  );
  if (rows.length === 0) {
    return res.status(401).json({ error: "Invalid or revoked API key" });
  }

  req.auth = { apiKeyId: rows[0].id, userId: rows[0].user_id };
  next();
}

// Self-service: get an API key for an email. Open, no auth, no rate limit.
router.post("/users/token", wrap(async (req, res) => {
  const { email, label } = req.body || {};
  if (typeof email !== "string" || email.trim() === "") {
    return res.status(400).json({ error: "'email' is required" });
  }

  const [existing] = await pool.query(`SELECT id FROM users WHERE email = ?`, [email]);
  let userId = existing[0]?.id;
  if (!userId) {
    const [result] = await pool.query(`INSERT INTO users (email) VALUES (?)`, [email]);
    userId = result.insertId;
  }

  const apiKey = generateToken("ak");
  const [result] = await pool.query(
    `INSERT INTO api_keys (user_id, key_hash, label) VALUES (?, ?, ?)`,
    [userId, sha256Hex(apiKey), label || null]
  );

  res.status(201).json({ id: result.insertId, userId, email, label: label || null, apiKey });
}));

// Customer entry point into the queue. status starts at 0 (queued).
// Limited to DAILY_SMS_LIMIT_PER_API_KEY submissions per API key per
// rolling 24h, computed straight from sms_queue - no separate rate-limit
// table (see idx_sms_queue_api_key_created in the schema).
router.post("/sms", customerAuth, wrap(async (req, res) => {
  const { to, message } = req.body || {};
  if (typeof to !== "string" || to.trim() === "") {
    return res.status(400).json({ error: "'to' is required" });
  }
  if (typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "'message' is required" });
  }

  const [[{ count }]] = await pool.query(
    `SELECT COUNT(*) AS count FROM sms_queue
     WHERE api_key_id = ? AND created_at >= (NOW() - INTERVAL 1 DAY)`,
    [req.auth.apiKeyId]
  );
  if (count >= DAILY_SMS_LIMIT_PER_API_KEY) {
    return res.status(429).json({
      error: `Daily limit of ${DAILY_SMS_LIMIT_PER_API_KEY} SMS per API key reached`,
    });
  }

  const [result] = await pool.query(
    `INSERT INTO sms_queue (user_id, api_key_id, to_number, message, status)
     VALUES (?, ?, ?, ?, 0)`,
    [req.auth.userId, req.auth.apiKeyId, to, message]
  );

  res.status(201).json({ id: result.insertId, to, message, status: 0 });
}));

module.exports = router;
