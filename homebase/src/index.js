// Home Base — one Worker serving the dashboard and its API.
//
// Static files under public/ are served directly by Cloudflare and contain no
// data. Everything that touches Ashley's accounts lives under /api and is
// behind a session cookie.

import { json, unauthorized, ConfigError, UpstreamError } from "./lib/http.js";
import {
  createSession,
  verifySession,
  readCookie,
  sessionCookie,
  clearCookie,
  passwordMatches,
} from "./lib/auth.js";
import { handleTasks, cachedTasks } from "./routes/tasks.js";
import { handleCalendar, cachedCalendar } from "./routes/calendar.js";
import { handleMoney, cachedMoney } from "./routes/money.js";
import { handleChat } from "./routes/chat.js";
import { handleMonth } from "./routes/month.js";
import { handleCreateTask } from "./routes/taskCreate.js";
import { handleComplete, handleSetStatus, handleSetDue } from "./routes/taskEdits.js";
import {
  handleInvoiceStatus,
  handleInvoiceDue,
  handleBillPaid,
  handleBillPaidThrough,
  handleCreateInvoice,
  handleCreateBill,
} from "./routes/moneyEdits.js";

const CACHED = {
  tasks: cachedTasks,
  calendar: cachedCalendar,
  money: cachedMoney,
};

const SECTIONS = {
  tasks: handleTasks,
  calendar: handleCalendar,
  money: handleMoney,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      return await route(request, env, ctx, url);
    } catch (err) {
      return errorResponse(err);
    }
  },
};

async function route(request, env, ctx, url) {
  if (url.pathname === "/api/login" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!(await passwordMatches(env, body.password))) {
      return json({ error: "Wrong password" }, { status: 401 });
    }
    const token = await createSession(env);
    return json({ ok: true }, { headers: { "set-cookie": sessionCookie(token, url) } });
  }

  if (url.pathname === "/api/logout" && request.method === "POST") {
    return json({ ok: true }, { headers: { "set-cookie": clearCookie(url) } });
  }

  const signedIn = await verifySession(env, readCookie(request));

  if (url.pathname === "/api/session") {
    return json({ signedIn });
  }

  if (!signedIn) return unauthorized();

  const section = url.pathname.match(/^\/api\/dashboard\/(tasks|calendar|money)$/)?.[1];
  if (section && request.method === "GET") {
    // ?cached=1 answers from the last good snapshot so a reload paints
    // immediately while the live pull runs in the background.
    if (url.searchParams.get("cached") === "1") {
      const snapshot = await CACHED[section](env);
      return json(snapshot ? { ...snapshot, cached: true } : { cached: true, empty: true });
    }
    return SECTIONS[section](env, ctx);
  }

  if (url.pathname === "/api/chat" && request.method === "POST") {
    return handleChat(request, env);
  }

  if (url.pathname === "/api/dashboard/month" && request.method === "GET") {
    return handleMonth(env, ctx, url);
  }

  if (url.pathname === "/api/tasks" && request.method === "POST") {
    return handleCreateTask(request, env);
  }

  const edit = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(complete|status|due)$/);
  if (edit && request.method === "POST") {
    const [, taskId, action] = edit;
    if (action === "complete") return handleComplete(env, decodeURIComponent(taskId));
    if (action === "status") return handleSetStatus(request, env, decodeURIComponent(taskId));
    return handleSetDue(request, env, decodeURIComponent(taskId));
  }

  if (url.pathname === "/api/money/invoices" && request.method === "POST") {
    return handleCreateInvoice(request, env);
  }

  if (url.pathname === "/api/money/bills" && request.method === "POST") {
    return handleCreateBill(request, env);
  }

  const invoice = url.pathname.match(/^\/api\/money\/invoices\/([^/]+)\/(status|due)$/);
  if (invoice && request.method === "POST") {
    const [, recordId, action] = invoice;
    const id = decodeURIComponent(recordId);
    return action === "status" ? handleInvoiceStatus(request, env, id) : handleInvoiceDue(request, env, id);
  }

  const bill = url.pathname.match(/^\/api\/money\/bills\/([^/]+)\/(paid|paid-through)$/);
  if (bill && request.method === "POST") {
    const [, recordId, action] = bill;
    const id = decodeURIComponent(recordId);
    return action === "paid" ? handleBillPaid(request, env, id) : handleBillPaidThrough(request, env, id);
  }

  return json({ error: "Not found" }, { status: 404 });
}

function errorResponse(err) {
  if (err instanceof ConfigError) {
    return json({ error: `Not configured — ${err.message}` }, { status: 503 });
  }
  if (err instanceof UpstreamError) {
    return json({ error: err.message, service: err.service }, { status: 502 });
  }
  console.error(err);
  return json({ error: err.message || "Something went wrong" }, { status: 500 });
}
