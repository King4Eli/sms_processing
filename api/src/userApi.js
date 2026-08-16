// Everything a customer/website touches: get an API key, submit an SMS.
const express = require("express");
const { pool } = require("./db");
const { sha256Hex, generateToken } = require("./crypto");
const { isValidEmail, parsePhone } = require("./validate");

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

async function customerAuth(req, res, next) {
  const apiKey = req.header("X-Api-Key");
  if (!apiKey) {
    return res.status(401).json({ error: "Missing X-Api-Key header" });
  }

  const [rows] = await pool.query(
    `SELECT id, user_id, daily_sms_limit FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL LIMIT 1`,
    [sha256Hex(apiKey)],
  );
  if (rows.length === 0) {
    return res.status(401).json({ error: "Invalid or revoked API key" });
  }

  req.auth = {
    apiKeyId: rows[0].id,
    userId: rows[0].user_id,
    dailySmsLimit: rows[0].daily_sms_limit,
  };
  next();
}

// Self-service: get an API key for an email + phone number. Open, no auth,
// no rate limit.
router.post(
  "/users/token",
  wrap(async (req, res) => {
    const { email, phone, label } = req.body || {};
    if (!isValidEmail(email)) {
      return res
        .status(400)
        .json({ error: "'email' must be a valid email address" });
    }

    const parsedPhone = parsePhone(phone);
    if (!parsedPhone) {
      return res.status(400).json({
        error:
          "'phone' must be a valid phone number in international format, e.g. +15551234567",
      });
    }
    const { e164: phoneE164, country } = parsedPhone;

    const [existing] = await pool.query(
      `SELECT id FROM users WHERE email = ?`,
      [email],
    );
    let userId = existing[0]?.id;
    if (userId) {
      await pool.query(
        `UPDATE users SET phone_number = ?, country = ? WHERE id = ?`,
        [phoneE164, country, userId],
      );
    } else {
      const [result] = await pool.query(
        `INSERT INTO users (email, phone_number, country) VALUES (?, ?, ?)`,
        [email, phoneE164, country],
      );
      userId = result.insertId;
    }

    const apiKey = generateToken("ak");
    const [result] = await pool.query(
      `INSERT INTO api_keys (user_id, key_hash, label) VALUES (?, ?, ?)`,
      [userId, sha256Hex(apiKey), label || null],
    );

    res.status(201).json({
      id: result.insertId,
      userId,
      email,
      phone: phoneE164,
      country,
      label: label || null,
      apiKey,
    });
  }),
);

// Lists the numbers available to send from, so a customer can pick one
// for 'from' below: every PUBLIC worker number (shared, from anyone) plus
// any private worker an admin has assigned to this caller specifically
// (worker_tokens.user_id, set via POST /admin/workers - see adminApi.js;
// customers can never create or own a worker themselves). Someone else's
// private worker never appears here.
router.get(
  "/numbers",
  customerAuth,
  wrap(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT phone_number FROM worker_tokens
     WHERE revoked_at IS NULL AND (is_public = 1 OR user_id = ?)
     ORDER BY phone_number ASC`,
      [req.auth.userId],
    );
    res.status(200).json(rows.map((r) => r.phone_number));
  }),
);

// Customer entry point into the queue. status starts at 0 (queued).
// 'from' must be an active worker_tokens.phone_number that's either
// public or admin-assigned to this caller (same visibility rule as GET
// /numbers) - that worker becomes the only one that can ever pull/complete
// this row (see workerApi.js). Limited to this key's api_keys.daily_sms_limit
// submissions per rolling 24h, computed straight from sms_queue - no
// separate rate-limit table (see idx_sms_queue_api_key_created).
router.post(
  "/sms",
  customerAuth,
  wrap(async (req, res) => {
    const { to, from, message } = req.body || {};
    const parsedTo = parsePhone(to);
    if (!parsedTo) {
      return res.status(400).json({
        error:
          "'to' must be a valid phone number in international format, e.g. +15551234567",
      });
    }
    const parsedFrom = parsePhone(from);
    if (!parsedFrom) {
      return res.status(400).json({
        error:
          "'from' must be a valid phone number in international format, e.g. +15551234567",
      });
    }
    if (typeof message !== "string" || message.trim() === "") {
      return res.status(400).json({ error: "'message' is required" });
    }

    const [workerRows] = await pool.query(
      `SELECT id FROM worker_tokens
     WHERE phone_number = ? AND revoked_at IS NULL AND (is_public = 1 OR user_id = ?) LIMIT 1`,
      [parsedFrom.e164, req.auth.userId],
    );
    if (workerRows.length === 0) {
      return res
        .status(400)
        .json({
          error: "'from' is not a recognized sending number - see GET /numbers",
        });
    }
    const workerTokenId = workerRows[0].id;

    const [[{ count }]] = await pool.query(
      `SELECT COUNT(*) AS count FROM sms_queue
     WHERE api_key_id = ? AND created_at >= (NOW() - INTERVAL 1 DAY)`,
      [req.auth.apiKeyId],
    );
    if (count >= req.auth.dailySmsLimit) {
      return res.status(429).json({
        error: `Daily limit of ${req.auth.dailySmsLimit} SMS per API key reached`,
      });
    }

    const [result] = await pool.query(
      `INSERT INTO sms_queue (user_id, api_key_id, worker_token_id, to_number, message, status)
     VALUES (?, ?, ?, ?, ?, 0)`,
      [
        req.auth.userId,
        req.auth.apiKeyId,
        workerTokenId,
        parsedTo.e164,
        message,
      ],
    );

    res.status(201).json({
      id: result.insertId,
      to: parsedTo.e164,
      from: parsedFrom.e164,
      message,
      status: 0,
    });
  }),
);

module.exports = router;
