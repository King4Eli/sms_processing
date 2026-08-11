// Admin-only operations: worker (device) management. Workers are never
// self-service - a customer can never create, list, or revoke one, only
// select an already-provisioned number as 'from' (see userApi.js). Gated
// by a single static secret in .env/admin.env (ADMIN_TOKEN), not a
// per-user credential and not stored in the database.
const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");

require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env", "admin.env") });

const { pool } = require("./db");
const { sha256Hex, generateToken } = require("./crypto");
const { parsePhone } = require("./validate");

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function adminAuth(req, res, next) {
  if (!process.env.ADMIN_TOKEN) {
    return res.status(503).json({ error: "Admin API not configured - missing ADMIN_TOKEN" });
  }
  const token = req.header("X-Admin-Token");
  if (!token || !timingSafeEqualStr(token, process.env.ADMIN_TOKEN)) {
    return res.status(401).json({ error: "Missing or invalid X-Admin-Token header" });
  }
  next();
}

router.use("/admin", adminAuth);

// HTTP equivalent of scripts/create-worker-token.js - the same worker
// concept, just reachable without container exec access. 'userId' is
// optional: set it to tie the worker to one customer account (they alone
// may use it as 'from' even when not public, via GET /numbers /
// POST /sms in userApi.js); omit for a global worker exactly like the
// CLI script produces.
router.post("/admin/workers", wrap(async (req, res) => {
  const { name, phone, public: isPublicInput, userId } = req.body || {};
  if (typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ error: "'name' is required" });
  }
  const parsedPhone = parsePhone(phone);
  if (!parsedPhone) {
    return res.status(400).json({
      error: "'phone' must be a valid phone number in international format, e.g. +15551234567",
    });
  }
  const isPublic = Boolean(isPublicInput);

  let ownerId = null;
  if (userId !== undefined && userId !== null) {
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "'userId' must be a positive integer" });
    }
    const [userRows] = await pool.query(`SELECT id FROM users WHERE id = ?`, [userId]);
    if (userRows.length === 0) {
      return res.status(400).json({ error: "No such user" });
    }
    ownerId = userId;
  }

  const token = generateToken("wk");
  try {
    const [result] = await pool.query(
      `INSERT INTO worker_tokens (user_id, name, phone_number, is_public, token_hash) VALUES (?, ?, ?, ?, ?)`,
      [ownerId, name.trim(), parsedPhone.e164, isPublic ? 1 : 0, sha256Hex(token)]
    );
    res.status(201).json({
      id: result.insertId,
      name: name.trim(),
      phone: parsedPhone.e164,
      isPublic,
      userId: ownerId,
      token,
    });
  } catch (err) {
    if (err.errno === 1062) {
      return res.status(409).json({ error: "That phone number is already registered to a worker" });
    }
    throw err;
  }
}));

// Every worker, across every customer. Never returns the token - only
// shown once, at creation.
router.get("/admin/workers", wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, user_id, name, phone_number, is_public, created_at, revoked_at
     FROM worker_tokens ORDER BY created_at DESC`
  );
  res.status(200).json(
    rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      name: r.name,
      phone: r.phone_number,
      isPublic: Boolean(r.is_public),
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
    }))
  );
}));

// Revokes any worker, owned or global - admin isn't bound by the
// ownership check customer-facing routes would need.
router.patch("/admin/workers/:id/revoke", wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid worker id" });
  }

  const [result] = await pool.query(
    `UPDATE worker_tokens SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL`,
    [id]
  );
  if (result.affectedRows === 0) {
    const [existing] = await pool.query(`SELECT id FROM worker_tokens WHERE id = ?`, [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: "Worker not found" });
    }
    return res.status(409).json({ error: "Worker is already revoked" });
  }

  res.status(200).json({ id, revoked: true });
}));

module.exports = router;
