export function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

export function badRequest(message) {
  return json({ error: message }, { status: 400 });
}

export function unauthorized(message = "Not signed in") {
  return json({ error: message }, { status: 401 });
}

/** A configuration problem, reported as a problem rather than a stack trace. */
export class ConfigError extends Error {}

/** An upstream service said no. `service` names it so the card can say which one. */
export class UpstreamError extends Error {
  constructor(service, message) {
    super(`${service}: ${message}`);
    this.service = service;
  }
}

export function requireVar(env, name) {
  const value = env[name];
  if (!value) throw new ConfigError(`${name} is not set`);
  return value;
}

/**
 * fetch with a timeout and a readable error. Every outbound call in this Worker
 * goes through here so one wedged upstream can't hold a request open.
 */
export async function fetchJson(service, url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new UpstreamError(service, `timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new UpstreamError(service, err.message);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new UpstreamError(service, `HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError(service, `response was not JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Run the parts of a dashboard section independently so one dead source
 * degrades that card instead of the whole endpoint. Returns the settled value
 * or `fallback`, and pushes a note onto `warnings`.
 */
export async function softly(warnings, label, promise, fallback) {
  try {
    return await promise;
  } catch (err) {
    warnings.push(`${label}: ${err.message}`);
    return fallback;
  }
}
