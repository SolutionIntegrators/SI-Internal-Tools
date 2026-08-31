#!/usr/bin/env node
// One-time helper: turns a Google OAuth client id/secret into a refresh token
// for the Worker. Run it once on Ashley's machine, signed into her Google
// account; the Worker uses the resulting token indefinitely.
//
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-oauth.mjs
//
// The Google Cloud project needs the Calendar API enabled and an OAuth client
// of type "Web application" with http://localhost:8976 as an authorized
// redirect URI.

import http from "node:http";
import { randomBytes } from "node:crypto";

const PORT = 8976;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.");
  process.exit(1);
}

const state = randomBytes(16).toString("hex");
const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  response_type: "code",
  scope: SCOPE,
  access_type: "offline",
  // Google only returns a refresh token on a fresh consent, so force one.
  prompt: "consent",
  state,
}).toString();

console.log("\nOpen this URL, sign in as Ashley, and approve calendar access:\n");
console.log(authUrl.toString());
console.log("\nWaiting for the redirect...\n");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");

  if (!code) {
    res.writeHead(400).end("No code in the redirect.");
    return;
  }
  if (url.searchParams.get("state") !== state) {
    res.writeHead(400).end("State mismatch — start over.");
    return;
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const data = await response.json();

  if (!data.refresh_token) {
    res.writeHead(500).end("No refresh token returned. Check the console.");
    console.error("\nGoogle returned:\n", data);
    console.error("\nIf this account already granted access, revoke it at");
    console.error("https://myaccount.google.com/permissions and run this again.");
    server.close();
    process.exit(1);
  }

  res.writeHead(200, { "content-type": "text/plain" }).end("Done. Back to the terminal.");

  console.log("Refresh token:\n");
  console.log(data.refresh_token);
  console.log("\nStore it with:\n");
  console.log("  npx wrangler secret put GOOGLE_REFRESH_TOKEN\n");
  server.close();
  process.exit(0);
});

server.listen(PORT);
