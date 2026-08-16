// Single-user session cookie. The dashboard reads Ashley's whole business, so
// the API is not open to the internet: every /api route except /api/login
// requires a cookie signed with SESSION_SECRET.
//
// Cloudflare Access in front of the Worker is the stronger option and is worth
// switching to if this ever has more than one user — see README.

import { requireVar } from "./http.js";

const COOKIE = "hb_session";
const SESSION_DAYS = 30;

const encoder = new TextEncoder();

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-independent comparison so a wrong guess leaks no timing signal. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function createSession(env) {
  const secret = requireVar(env, "SESSION_SECRET");
  const expires = Date.now() + SESSION_DAYS * 86400000;
  const signature = await hmac(secret, String(expires));
  return `${expires}.${signature}`;
}

export async function verifySession(env, token) {
  if (!token || !env.SESSION_SECRET) return false;
  const [expires, signature] = token.split(".");
  if (!expires || !signature) return false;
  if (Number(expires) < Date.now()) return false;
  return safeEqual(signature, await hmac(env.SESSION_SECRET, expires));
}

export function readCookie(request, name = COOKIE) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function sessionCookie(token, url) {
  const secure = url.protocol === "https:" ? " Secure;" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearCookie(url) {
  const secure = url.protocol === "https:" ? " Secure;" : "";
  return `${COOKIE}=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0`;
}

export async function passwordMatches(env, submitted) {
  const expected = requireVar(env, "DASHBOARD_PASSWORD");
  return typeof submitted === "string" && safeEqual(submitted, expected);
}
