const crypto = require("node:crypto");

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function generateToken(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
}

module.exports = { sha256Hex, generateToken };
