// auth.js — the dashboard's own password (not a provider credential). Hash
// lives in KV, never in the repo. The session-signing key generates itself
// on first use and is never something anyone types in.

const PBKDF2_ITERATIONS = 210000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256
  );
  return `${toHex(salt)}:${toHex(bits)}`;
}

export async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(":");
  const salt = fromHex(saltHex);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256
  );
  return toHex(bits) === hashHex;
}

async function getSigningKey(kv) {
  let keyHex = await kv.get("auth:signingKey");
  if (!keyHex) {
    keyHex = toHex(crypto.getRandomValues(new Uint8Array(32)));
    // Only ever set if still empty, to avoid a race invalidating live sessions.
    await kv.put("auth:signingKey", keyHex);
  }
  return crypto.subtle.importKey(
    "raw",
    fromHex(keyHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function createSessionCookie(kv) {
  const key = await getSigningKey(kv);
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = `${expires}`;
  const sig = toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  const value = `${payload}.${sig}`;
  return `dash_session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export async function verifySessionCookie(kv, cookieHeader) {
  if (!cookieHeader) return false;
  const match = cookieHeader.match(/dash_session=([^;]+)/);
  if (!match) return false;
  const [payload, sig] = decodeURIComponent(match[1]).split(".");
  if (!payload || !sig) return false;
  const key = await getSigningKey(kv);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    fromHex(sig),
    new TextEncoder().encode(payload)
  );
  if (!valid) return false;
  return Number(payload) > Date.now();
}

export const CLEAR_SESSION_COOKIE =
  "dash_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
