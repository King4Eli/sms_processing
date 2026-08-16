const { parsePhoneNumberFromString } = require("libphonenumber-js");

// HTML5-spec email pattern - thorough without being a full RFC 5322 parser.
const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

function isValidEmail(email) {
  return (
    typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email)
  );
}

// Requires an internationally-formatted number (leading + and country
// code, e.g. +15551234567) so the country can be determined unambiguously.
// Returns null if the number doesn't parse or isn't a real, valid number
// for its country (not just "looks like digits").
function parsePhone(phone) {
  if (typeof phone !== "string") return null;
  const parsed = parsePhoneNumberFromString(phone);
  if (!parsed || !parsed.isValid()) return null;
  return { e164: parsed.number, country: parsed.country || null };
}

module.exports = { isValidEmail, parsePhone };
