// Last-good-snapshot cache. Optional: if the SNAPSHOTS KV namespace is not
// bound, every function here quietly no-ops and the dashboard just waits for
// live data. This is what makes a reload show something instantly.

const TTL_SECONDS = 86400;

export async function readSnapshot(env, key) {
  if (!env.SNAPSHOTS) return null;
  try {
    return await env.SNAPSHOTS.get(`snapshot:${key}`, "json");
  } catch {
    return null;
  }
}

export function writeSnapshot(env, key, value) {
  if (!env.SNAPSHOTS) return Promise.resolve();
  return env.SNAPSHOTS.put(`snapshot:${key}`, JSON.stringify(value), {
    expirationTtl: TTL_SECONDS,
  }).catch(() => {});
}
