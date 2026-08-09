const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");

require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env", "db.env") });

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
});

// Applies _docs/schema.sql - the single source of truth for the schema,
// nothing here duplicates it. Safe to run on every startup: statements are
// CREATE TABLE IF NOT EXISTS, and "already exists" errors (dup table/index)
// are swallowed since this file always re-applies the whole schema rather
// than tracking which pieces already ran.
async function ensureSchema() {
  const schemaPath = path.join(__dirname, "..", "..", "_docs", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");

  const statements = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    try {
      await pool.query(statement);
    } catch (err) {
      const alreadyExists = [1050, 1060, 1061].includes(err.errno); // table/column/index exists
      if (!alreadyExists) throw err;
    }
  }
}

module.exports = { pool, ensureSchema };
