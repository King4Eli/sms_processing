// Run inside the api container - this is the only way to mint a worker
// token (no HTTP route for it): a leaked/open endpoint would hand out
// full pull-and-complete access to every customer's queue to anyone who
// finds it. See _docs/worker-api.md.
const { pool } = require("../src/db");
const { sha256Hex, generateToken } = require("../src/crypto");
const { parsePhone } = require("../src/validate");

const USAGE = `Usage:
  node scripts/create-worker-token.js "<device name>" "<phone, e.g. +15551234567>" [--public]

  docker compose exec api node scripts/create-worker-token.js "worker-livingroom" "+15551234567" --public

Arguments:
  <device name>   Any string identifying this worker. Required.
  <phone>          The "from" number this worker sends as. Required,
                    international format, strictly validated before
                    insert (rejected if not a real, valid number).

Options:
  --public, -p     Make this number visible to customers via GET
                    /numbers and usable as 'from' in POST /sms.
                    Default: private (customers can't see or use it).
  -h, --help        Show this help and exit.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }

  const isPublic = args.includes("--public") || args.includes("-p");
  const positional = args.filter((a) => a !== "--public" && a !== "-p");
  const [name, phone] = positional;

  if (!name || !phone) {
    console.error(USAGE);
    process.exit(1);
  }

  const parsedPhone = parsePhone(phone);
  if (!parsedPhone) {
    console.error(
      `"${phone}" is not a valid phone number in international format (e.g. +15551234567) - rejected before insert.`
    );
    process.exit(1);
  }

  const token = generateToken("wk");
  const [result] = await pool.query(
    `INSERT INTO worker_tokens (name, phone_number, is_public, token_hash) VALUES (?, ?, ?, ?)`,
    [name, parsedPhone.e164, isPublic ? 1 : 0, sha256Hex(token)]
  );

  console.log(
    `Worker token created (id ${result.insertId}) for "${name}" <${parsedPhone.e164}>, ${
      isPublic ? "public" : "private"
    }. Store it now, it will not be shown again:\n`
  );
  console.log(token);

  await pool.end();
}

main().catch((err) => {
  if (err.errno === 1062) {
    console.error(`That phone number is already assigned to another worker token.`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
