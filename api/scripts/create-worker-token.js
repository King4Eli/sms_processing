// Run inside the api container - this is the only way to mint a worker
// token (no HTTP route for it): a leaked/open endpoint would hand out
// full pull-and-complete access to every customer's queue to anyone who
// finds it. See _docs/worker-api.md.
//
//   docker compose exec api node scripts/create-worker-token.js "worker-livingroom"
const { pool } = require("../src/db");
const { sha256Hex, generateToken } = require("../src/crypto");

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: node scripts/create-worker-token.js "<device name>"');
    process.exit(1);
  }

  const token = generateToken("wk");
  const [result] = await pool.query(`INSERT INTO worker_tokens (name, token_hash) VALUES (?, ?)`, [
    name,
    sha256Hex(token),
  ]);

  console.log(`Worker token created (id ${result.insertId}) for "${name}". Store it now, it will not be shown again:\n`);
  console.log(token);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
