// Everything the worker (the device sending SMS) touches: pull the next
// SMS, report one as sent. Worker tokens themselves are NOT issued over
// HTTP - see scripts/create-worker-token.js, run via `docker exec`/
// `docker compose exec`. See _docs/worker-api.md.
const express = require("express");
const { pool } = require("./db");
const { sha256Hex } = require("./crypto");

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

async function workerAuth(req, res, next) {
  const [scheme, token] = (req.header("Authorization") || "").split(" ");
  if (scheme !== "Bearer" || !token) {
    return res
      .status(401)
      .json({ error: "Missing or malformed worker Authorization header" });
  }

  const [rows] = await pool.query(
    `SELECT id FROM worker_tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
    [sha256Hex(token)],
  );
  if (rows.length === 0) {
    return res.status(401).json({ error: "Invalid or revoked worker token" });
  }

  req.worker = { workerTokenId: rows[0].id };
  next();
}

router.use("/worker", workerAuth);

const MAX_PULL_BATCH_SIZE = 100;

// Atomically claims up to `count` oldest queued SMS submitted against
// THIS worker's own number: status 0 -> 2 each. A worker can never see or
// claim an SMS that was submitted with a different 'from' number - that's
// enforced by the WHERE worker_token_id = ? below, not just convention.
// SELECT ... FOR UPDATE SKIP LOCKED lets concurrent workers each grab
// different rows without blocking on rows another worker already has
// locked; the batch UPDATE is scoped to exactly those locked ids, so a
// row already claimed by another worker between SELECT and UPDATE can't
// be double-counted.
router.post(
  "/worker/sms/pull",
  wrap(async (req, res) => {
    const { count } = req.body || {};
    const batchSize = count === undefined ? 1 : count;
    if (
      !Number.isInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > MAX_PULL_BATCH_SIZE
    ) {
      return res.status(400).json({
        error: `'count' must be an integer between 1 and ${MAX_PULL_BATCH_SIZE}`,
      });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [candidates] = await conn.query(
        `SELECT id FROM sms_queue WHERE worker_token_id = ? AND status = 0
       ORDER BY created_at ASC LIMIT ? FOR UPDATE SKIP LOCKED`,
        [req.worker.workerTokenId, batchSize],
      );
      if (candidates.length === 0) {
        await conn.commit();
        return res.status(200).json([]);
      }

      const ids = candidates.map((row) => row.id);
      await conn.query(
        `UPDATE sms_queue SET status = 2, pulled_at = NOW(), attempts = attempts + 1 WHERE id IN (?)`,
        [ids],
      );

      const [rows] = await conn.query(
        `SELECT * FROM sms_queue WHERE id IN (?) ORDER BY created_at ASC`,
        [ids],
      );
      await conn.commit();

      res
        .status(200)
        .json(
          rows.map((sms) => ({
            id: sms.id,
            to: sms.to_number,
            message: sms.message,
            status: sms.status,
          })),
        );
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }),
);

// Reports the outcome of a previously-claimed (status=2) SMS. Only the
// worker whose number it was submitted against can report on it - same
// scoping as pull, checked explicitly below (not just implied by pull
// having been scoped, since a different valid worker token could
// otherwise guess/enumerate ids).
//   { "status": 1 }                          -> 2 -> 1, sets processed_at (done)
//   { "status": 0, "error_message": "..." }   -> 2 -> 0, sets error_message,
//                                                 re-queued for another pull
//                                                 (attempts increments again
//                                                 on that next pull)
// No other status value or transition is allowed.
router.patch(
  "/worker/sms/:id/status",
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { status, error_message: errorMessage } = req.body || {};

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid SMS id" });
    }
    if (status !== 1 && status !== 0) {
      return res
        .status(400)
        .json({ error: "'status' must be 1 (sent) or 0 (failed, re-queue)" });
    }
    if (
      status === 0 &&
      (typeof errorMessage !== "string" || errorMessage.trim() === "")
    ) {
      return res
        .status(400)
        .json({ error: "'error_message' is required when status is 0" });
    }

    const [existingRows] = await pool.query(
      `SELECT status, worker_token_id FROM sms_queue WHERE id = ?`,
      [id],
    );
    if (existingRows.length === 0) {
      return res.status(404).json({ error: "SMS not found" });
    }
    if (existingRows[0].worker_token_id !== req.worker.workerTokenId) {
      return res
        .status(403)
        .json({
          error: "This SMS was not submitted against your worker number",
        });
    }

    const [updateResult] =
      status === 1
        ? await pool.query(
            `UPDATE sms_queue SET status = 1, processed_at = NOW() WHERE id = ? AND status = 2`,
            [id],
          )
        : await pool.query(
            `UPDATE sms_queue SET status = 0, error_message = ? WHERE id = ? AND status = 2`,
            [errorMessage, id],
          );

    if (updateResult.affectedRows === 0) {
      return res.status(409).json({
        error: `SMS ${id} is not in a claimed (status=2) state; current status is ${existingRows[0].status}`,
      });
    }

    res.status(200).json({ id, status });
  }),
);

module.exports = router;
