// Shared helpers: auth storage, nav rendering, fetch wrapper. Loaded by
// every page before its own inline script.
const AUTH_STORAGE_KEY = "sms_api_key";

function getApiKey() {
  return localStorage.getItem(AUTH_STORAGE_KEY) || "";
}

function setApiKey(key) {
  localStorage.setItem(AUTH_STORAGE_KEY, key);
}

function clearApiKey() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

function isLoggedIn() {
  return getApiKey().length > 0;
}

// Attaches X-Api-Key automatically; throws with a readable message on
// network failure so callers can just try/catch and show it.
async function apiFetch(path, options = {}) {
  const headers = Object.assign({}, options.headers);
  const apiKey = getApiKey();
  if (apiKey) headers["X-Api-Key"] = apiKey;
  const res = await fetch(path, Object.assign({}, options, { headers }));
  let body = null;
  try {
    body = await res.json();
  } catch (err) {
    body = null;
  }
  return { res, body };
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 10) return key;
  return `${key.slice(0, 6)}${"•".repeat(6)}${key.slice(-4)}`;
}

// Admin token: deliberately separate storage/header from the customer
// API key above - an admin token must never be sent as X-Api-Key or
// vice versa.
const ADMIN_STORAGE_KEY = "sms_admin_token";

function getAdminToken() {
  return localStorage.getItem(ADMIN_STORAGE_KEY) || "";
}

function setAdminToken(token) {
  localStorage.setItem(ADMIN_STORAGE_KEY, token);
}

function clearAdminToken() {
  localStorage.removeItem(ADMIN_STORAGE_KEY);
}

function isAdmin() {
  return getAdminToken().length > 0;
}

async function adminFetch(path, options = {}) {
  const headers = Object.assign({}, options.headers);
  const token = getAdminToken();
  if (token) headers["X-Admin-Token"] = token;
  const res = await fetch(path, Object.assign({}, options, { headers }));
  let body = null;
  try {
    body = await res.json();
  } catch (err) {
    body = null;
  }
  return { res, body };
}

// Renders the auth pill in the top header (logged in state / login link)
// and highlights the active nav tab. Call once per page on load.
function initChrome(activePage) {
  document.querySelectorAll("nav.tabs a[data-page]").forEach((a) => {
    a.classList.toggle("active", a.dataset.page === activePage);
  });

  const pill = document.getElementById("auth-pill");
  if (!pill) return;
  if (isLoggedIn()) {
    pill.textContent = "Logged in";
    pill.href = "account.html";
  } else {
    pill.textContent = "Log in";
    pill.href = "account.html";
  }
}

function showResult(el, ok, text) {
  el.hidden = false;
  el.className = ok ? "result ok" : "result err";
  el.textContent = text;
}
