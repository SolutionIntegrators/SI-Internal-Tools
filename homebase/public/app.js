// Home Base frontend. The dashboard tiles are rendered from whatever the
// Worker computed — no parsing, no model output to second-guess.

// The month grid covers calendar events now, so /api/dashboard/calendar is
// no longer fetched on load — only these two feed the tabs.
const SECTIONS = ["money", "tasks"];

let dashboard = {};
let status = { tasks: "idle", calendar: "idle", money: "idle" };
let errors = { tasks: null, calendar: null, money: null };
let chatHistory = [];

const $ = (id) => document.getElementById(id);

// ---------- Fetch ----------

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...options,
  });
  if (response.status === 401) {
    showGate();
    throw new Error("Signed out");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function loadSection(key, { cached = false } = {}) {
  if (!cached) {
    status[key] = "loading";
    errors[key] = null;
    render();
    updateAsOf();
  }
  try {
    const data = await api(`/api/dashboard/${key}${cached ? "?cached=1" : ""}`);
    if (cached && data.empty) return false;
    Object.assign(dashboard, data);
    status[key] = "done";
    return true;
  } catch (err) {
    if (cached) return false;
    status[key] = "error";
    errors[key] = err.message;
    return false;
  } finally {
    if (!cached) {
      render();
      updateAsOf();
    }
  }
}

async function refresh() {
  const button = $("refreshBtn");
  button.disabled = true;
  button.textContent = "Refreshing...";
  await Promise.allSettled(SECTIONS.map((key) => loadSection(key)));
  button.disabled = false;
  button.textContent = "Refresh";
}

function updateAsOf() {
  const values = Object.values(status);
  if (values.includes("loading")) {
    $("asOfLabel").textContent = "Refreshing...";
    return;
  }
  const stamp = new Date().toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  $("asOfLabel").textContent = (values.includes("error") ? "Partially updated " : "As of ") + stamp;
}

// ---------- Render ----------

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}

function statusLabel(value) {
  return { on_track: "On track", needs_attention: "Needs attention", stalled: "Stalled" }[value] || value;
}

function loadingCard(message) {
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<div class="loading-msg">${escapeHtml(message)}</div>`;
  return card;
}

function errorCard(message, key) {
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<div class="error-msg">Couldn't load this (${escapeHtml(message)}). <button data-retry="${key}">Try again</button></div>`;
  return card;
}

function buildCard(title, items, rowFn, extraClass) {
  const card = document.createElement("div");
  card.className = "card" + (extraClass ? ` ${extraClass}` : "");
  const body = items && items.length ? items.map(rowFn).join("") : '<div class="empty-row">Nothing here right now.</div>';
  card.innerHTML = `<h2>${escapeHtml(title)}</h2>${body}`;
  return card;
}

function buildSection(label, cards, colsClass) {
  const wrap = document.createElement("div");
  wrap.className = "section-block";
  const labelEl = document.createElement("div");
  labelEl.className = "section-label";
  labelEl.textContent = label;
  const grid = document.createElement("div");
  grid.className = "section-grid" + (colsClass ? ` ${colsClass}` : "");
  cards.forEach((card) => grid.appendChild(card));
  wrap.appendChild(labelEl);
  wrap.appendChild(grid);
  return wrap;
}

/**
 * A task row that can be acted on. The checkbox completes the task in ClickUp;
 * the due date opens a native date picker, which is the one control that
 * behaves well on both desktop and a phone without inventing a widget.
 */
function taskRow(task, showDue) {
  const due = showDue && task.due ? `· due <button class="due-control" data-due-for="${escapeHtml(task.id)}" data-due-value="${escapeHtml(task.dueDate || "")}">${escapeHtml(task.due)}</button>` : "";
  return `<div class="row editable" data-task-row="${escapeHtml(task.id)}">
    <input type="checkbox" class="task-check" data-complete="${escapeHtml(task.id)}" data-status="${escapeHtml(task.status || "")}" title="Mark complete">
    <div class="row-main">
      <span class="row-title">${escapeHtml(task.title)}</span>
      <div class="row-sub">${escapeHtml(task.client || "")} ${due}</div>
    </div>
  </div>`;
}

/**
 * An invoice from Invoice Tracking. The checkbox marks it Paid in Airtable and
 * the date opens a picker on the expected date — both behind a confirm, because
 * money is the one place where an accidental tap is expensive.
 */
function paymentRow(p) {
  if (!p.id) {
    return `<div class="row"><span class="row-title">${escapeHtml(p.client)}${p.amount ? " — " + escapeHtml(p.amount) : ""}</span><div class="row-sub">${escapeHtml(p.expected || "")}</div></div>`;
  }
  const label = p.expected ? escapeHtml(p.expected) : "no date";
  return `<div class="row editable" data-money-row="invoice:${escapeHtml(p.id)}">
    <input type="checkbox" class="money-check" data-invoice-paid="${escapeHtml(p.id)}" data-label="${escapeHtml(p.client)}" data-amount="${escapeHtml(p.amount || "")}" title="Mark paid in Airtable">
    <div class="row-main">
      <span class="row-title">${escapeHtml(p.client)}${p.amount ? " — " + escapeHtml(p.amount) : ""}</span>
      <div class="row-sub">expected <button class="due-control" data-invoice-due="${escapeHtml(p.id)}" data-due-value="${escapeHtml(p.expected || "")}">${label}</button></div>
    </div>
  </div>`;
}

/**
 * A bill occurrence. Recurring Items are rules rather than one row per payment,
 * so checking one off records a Paid Through date on the rule — this occurrence
 * disappears and next month's still arrives on schedule.
 */
function billRow(b, writable) {
  if (!writable || !b.id) {
    return `<div class="row"><span class="row-title">${escapeHtml(b.name)}${b.amount ? " — " + escapeHtml(b.amount) : ""}</span><div class="row-sub">${escapeHtml(b.due || "")}</div></div>`;
  }
  return `<div class="row editable" data-money-row="bill:${escapeHtml(b.id)}:${escapeHtml(b.due)}">
    <input type="checkbox" class="money-check" data-bill-paid="${escapeHtml(b.id)}" data-due="${escapeHtml(b.due)}" data-prev="${escapeHtml(b.paidThrough || "")}" data-label="${escapeHtml(b.name)}" data-amount="${escapeHtml(b.amount || "")}" title="Mark this bill paid">
    <div class="row-main">
      <span class="row-title">${escapeHtml(b.name)}${b.amount ? " — " + escapeHtml(b.amount) : ""}</span>
      <div class="row-sub">due ${escapeHtml(b.due || "")}</div>
    </div>
  </div>`;
}

/**
 * Four tabs, four renderers. Each one owns its whole view rather than pushing
 * cards into a shared grid, because the tabs answer different questions and
 * were fighting each other for room on one page.
 */
const VIEWS = { money: renderMoney, work: renderWork, clients: renderClients, calendar: renderCalendar };
let activeView = "money";

function render() {
  VIEWS[activeView]();
  updateTabCounts();
}

function updateTabCounts() {
  const urgent = (dashboard.urgent || []).length;
  const badge = urgent ? `<span class="tab-count">${urgent}</span>` : "";
  $("viewWorkBtn").innerHTML = `Work${badge}`;
}

function money(n) {
  return "$" + Math.round(n).toLocaleString("en-US");
}

/** A big-number tile. `pct` null means no bar — the figure stands alone. */
function figure({ label, value, of, pct, note, badge, badgeClass, tone }) {
  const card = document.createElement("div");
  card.className = "figure" + (tone ? ` ${tone}` : "");
  card.innerHTML = `<div class="figure-label">${escapeHtml(label)}</div>
    <div class="figure-main">
      <div class="figure-num">${escapeHtml(value)}</div>
      ${of ? `<div class="figure-of">${escapeHtml(of)}</div>` : ""}
    </div>
    ${pct === null || pct === undefined ? "" : `<div class="figure-track"><div class="figure-fill" style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>`}
    ${badge ? `<div class="figure-badge ${badgeClass || ""}">${escapeHtml(badge)}</div>` : ""}
    <div class="figure-note">${note || ""}</div>`;
  return card;
}

// ---------- Money ----------

function renderMoney() {
  const root = $("moneyView");
  root.innerHTML = "";
  const d = dashboard;

  if (status.money === "error") return root.appendChild(errorCard(errors.money, "money"));
  if (status.money !== "done") return root.appendChild(loadingCard("Loading revenue, payments, and bills..."));

  const revenue = d.revenue || {};
  const week = d.week || {};
  const m = d.month;

  const figures = document.createElement("div");
  figures.className = "figure-row";

  const weekGoal = revenue.goal || 0;
  const weekCurrent = revenue.current || 0;
  figures.appendChild(
    figure({
      label: `This week${week.start ? ` · ${shortRange(week.start, week.end)}` : ""}`,
      value: money(weekCurrent),
      of: weekGoal ? `of ${money(weekGoal)}` : "",
      pct: weekGoal ? (weekCurrent / weekGoal) * 100 : 0,
      note: escapeHtml(revenue.note || ""),
    }),
  );

  if (m) {
    const shortBy = -m.toGoal;
    figures.appendChild(
      figure({
        label: `This month · ${m.label}`,
        value: money(m.actual),
        of: `of ${money(m.goal)}`,
        pct: m.goal ? (m.actual / m.goal) * 100 : 0,
        note:
          shortBy > 0
            ? `<span style="color:var(--burnt-orange);font-weight:600;">${money(shortBy)} short</span> — ${money(Math.max(0, m.projected - m.actual))} of that is already invoiced.`
            : `<span style="color:#2f6b4a;font-weight:600;">${money(m.toGoal)} over</span> — the month is already made.`,
      }),
    );

    // Projected is the one that changes the decision: short here means new work
    // to sell, not invoices to chase. It reads as a warning when it falls short.
    const gap = m.projectedToGoal;
    figures.appendChild(
      figure({
        label: "Projected close",
        value: money(m.projected),
        pct: null,
        tone: gap < 0 ? "warn" : "tinted",
        badge: gap < 0 ? `${money(-gap)} short of goal` : `${money(gap)} over goal`,
        badgeClass: gap < 0 ? "short" : "good",
        note:
          gap < 0
            ? "Everything already invoiced still leaves a gap. That is new work, not collection."
            : "Collected plus everything invoiced and still due this month.",
      }),
    );
  }
  root.appendChild(figures);

  const grid = document.createElement("div");
  grid.className = "section-grid";

  const payments = d.upcomingPayments || [];
  const paymentsTotal = payments.reduce((sum, p) => sum + parseMoney(p.amount), 0);
  grid.appendChild(
    moneyCard({
      title: "Money coming in",
      sub: payments.length ? `${money(paymentsTotal)} outstanding` : "",
      addKey: "invoice",
      rows: payments.map(paymentRow).join(""),
      empty: "Nothing invoiced and unpaid.",
    }),
  );

  const bills = d.upcomingBills || [];
  const billsTotal = bills.reduce((sum, b) => sum + parseMoney(b.amount), 0);
  const billsCard = moneyCard({
    title: "Money going out",
    sub: bills.length ? `${money(billsTotal)} next 7 days` : "",
    addKey: "bill",
    rows: bills.map((b) => billRow(b, d.billsWritable)).join(""),
    empty: "Nothing due in the next 7 days.",
  });

  const net = weekCurrent - billsTotal;
  const netBox = document.createElement("div");
  netBox.className = "net-box";
  netBox.innerHTML = `<div class="eyebrow" style="color:#7d736a;margin-bottom:6px;">Net this week</div>
    <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">
      <div class="net-num ${net >= 0 ? "up" : "down"}">${net >= 0 ? "+" : "−"}${money(Math.abs(net))}</div>
      <div class="card-sub">${money(weekCurrent)} in · ${money(billsTotal)} out</div>
    </div>`;
  billsCard.appendChild(netBox);
  grid.appendChild(billsCard);

  root.appendChild(grid);
  appendWarnings(root, d.warnings);
}

function moneyCard({ title, sub, addKey, rows, empty }) {
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<div class="card-head">
      <h2>${escapeHtml(title)}</h2>
      <div class="card-head-right">
        ${sub ? `<span class="card-sub">${escapeHtml(sub)}</span>` : ""}
        <button class="add-btn" data-add="${escapeHtml(addKey)}" title="Add">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
    </div>${rows || `<div class="empty-row">${escapeHtml(empty)}</div>`}`;
  return card;
}

function parseMoney(text) {
  const n = Number(String(text || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function shortRange(start, end) {
  const fmt = (iso) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${fmt(start)}–${fmt(end).replace(/^\w+\s/, "")}`;
}

// ---------- Work ----------

function renderWork() {
  const root = $("workView");
  root.innerHTML = "";
  const d = dashboard;

  if (status.tasks === "error") return root.appendChild(errorCard(errors.tasks, "tasks"));
  if (status.tasks !== "done") return root.appendChild(loadingCard("Loading tasks and tickets from ClickUp..."));

  // Anything urgent and already late gets the top of the page to itself.
  for (const task of d.urgent || []) {
    const bar = document.createElement("div");
    bar.className = "urgent-bar";
    bar.dataset.taskRow = task.id;
    bar.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="flex:none;"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
      <div style="flex:1;min-width:0;">
        <div class="urgent-title">${escapeHtml(task.title)}</div>
        <div class="urgent-sub">Marked urgent · due ${escapeHtml(task.dueDate || "")} · ${escapeHtml(task.due || "")}${task.list ? " · " + escapeHtml(task.list) : ""}</div>
      </div>
      <button data-complete-now="${escapeHtml(task.id)}">Mark done</button>`;
    root.appendChild(bar);
  }

  const grid = document.createElement("div");
  grid.className = "work-grid";

  // --- tasks, grouped by the day they are due ---
  const tasksCard = document.createElement("div");
  tasksCard.className = "card";
  const soon = d.myTasksSoon || [];
  let body = "";
  if (soon.length) {
    let lastDay = null;
    for (const task of soon) {
      if (task.dueDate !== lastDay) {
        lastDay = task.dueDate;
        const label = task.due === "today" ? "Today" : task.due === "tomorrow" ? "Tomorrow" : task.due;
        body += `<div class="day-label${task.due === "today" ? " today" : ""}">${escapeHtml(String(label || "").replace(/^\w/, (c) => c.toUpperCase()))} · ${escapeHtml(task.dueDate || "")}</div>`;
      }
      body += taskRow(task, false);
    }
  } else {
    body = '<div class="empty-row">Nothing due in the next three days.</div>';
  }
  const overdueCount = d.overdueCount || 0;
  tasksCard.innerHTML = `<div class="card-head">
      <h2>My tasks — next 3 days</h2>
      <button class="add-btn" data-add="task" title="Add a task">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>${body}
    ${overdueCount ? `<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--linen);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
      <span class="card-sub" style="color:var(--burnt-orange);">${overdueCount} already past due</span>
      <button class="due-control" data-toggle-overdue="1">${showOverdue ? "Hide" : "Show"} overdue</button>
    </div>` : ""}
    ${showOverdue ? (d.overdue || []).map((t) => taskRow(t, true)).join("") : ""}`;
  grid.appendChild(tasksCard);

  // --- rail: review, then tickets ---
  const rail = document.createElement("div");
  rail.className = "work-rail";

  const review = d.readyForReview || [];
  rail.appendChild(
    buildCard(`Waiting on you — ${review.length}`, review, (r) => taskRow(r, false)),
  );

  const tickets = d.supportTickets || {};
  const groups = tickets.byClient || [];
  const ticketsCard = document.createElement("div");
  ticketsCard.className = "card";
  ticketsCard.innerHTML = `<h2>Support tickets — ${tickets.openCount || 0} open</h2>${
    groups.length
      ? groups
          .map(
            (g) => `<div class="ticket-group">
              <div class="ticket-head">
                <span class="row-title">${escapeHtml(g.client)}</span>
                <span class="ticket-count${g.count > 1 ? " hot" : ""}">${g.count}</span>
              </div>
              <div class="row-sub">${g.oldestDays ? `Oldest open ${g.oldestDays} day${g.oldestDays === 1 ? "" : "s"}` : "Opened today"}${g.titles && g.titles.length ? " · " + escapeHtml(g.titles.slice(0, 2).join(", ")) : ""}</div>
            </div>`,
          )
          .join("")
      : '<div class="empty-row">Nothing open.</div>'
  }`;
  rail.appendChild(ticketsCard);

  grid.appendChild(rail);
  root.appendChild(grid);
  appendWarnings(root, d.warnings);
}

// ---------- Clients ----------

const TIMELINE_MONTHS = 3;

function renderClients() {
  const root = $("clientsView");
  root.innerHTML = "";
  const d = dashboard;

  if (status.tasks === "error") return root.appendChild(errorCard(errors.tasks, "tasks"));
  if (status.tasks !== "done") return root.appendChild(loadingCard("Loading client projects..."));

  const all = d.clientProjects || [];
  const builds = all.filter((p) => !p.retainer && p.milestones && p.milestones.kickoff);
  const retainers = all.filter((p) => p.retainer);
  const undated = all.filter((p) => !p.retainer && !(p.milestones && p.milestones.kickoff));

  const card = document.createElement("div");
  card.className = "card";
  const { start, end, months } = timelineWindow();

  card.innerHTML = `<div class="card-head">
      <h2>Active builds — ${builds.length}</h2>
      <div class="legend">
        <span><i style="background:var(--denim-blue)"></i>Kickoff</span>
        <span><i style="background:var(--burnt-orange)"></i>Implementation</span>
        <span><i style="background:var(--sunset-yellow)"></i>Walkthrough</span>
      </div>
    </div>
    <div class="timeline-head"><div></div><div class="timeline-months">${months.map((m) => `<span>${escapeHtml(m)}</span>`).join("")}</div></div>
    ${
      builds.length
        ? builds.map((p) => timelineRow(p, start, end)).join("")
        : '<div class="empty-row">No dated builds in this window.</div>'
    }`;
  root.appendChild(card);

  if (retainers.length) {
    const rc = document.createElement("div");
    rc.className = "card";
    rc.style.marginTop = "20px";
    rc.innerHTML = `<h2>Retainers — ${retainers.length}</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px 20px;">
        ${retainers
          .map(
            (p) =>
              `<div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;"><span class="row-title">${escapeHtml(p.name)}</span><span class="card-sub">${escapeHtml(p.phase || "")}</span></div>`,
          )
          .join("")}
      </div>`;
    root.appendChild(rc);
  }

  if (undated.length) {
    const uc = document.createElement("div");
    uc.className = "card";
    uc.style.marginTop = "20px";
    uc.innerHTML = `<h2>No dates set — ${undated.length}</h2>${undated
      .map((p) => `<div class="row"><span class="row-title">${escapeHtml(p.name)}</span><div class="row-sub">${escapeHtml(p.phase || "")}${p.note ? " — " + escapeHtml(p.note) : ""}</div></div>`)
      .join("")}`;
    root.appendChild(uc);
  }

  appendWarnings(root, d.warnings);
}

/** This month plus the next two, so the quarter ahead is visible at once. */
function timelineWindow() {
  const now = new Date();
  const first = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  const after = new Date(Date.UTC(now.getFullYear(), now.getMonth() + TIMELINE_MONTHS, 1));
  const months = [];
  for (let i = 0; i < TIMELINE_MONTHS; i++) {
    months.push(
      new Date(Date.UTC(now.getFullYear(), now.getMonth() + i, 1)).toLocaleDateString("en-US", {
        month: "long",
        timeZone: "UTC",
      }),
    );
  }
  return { start: first.getTime(), end: after.getTime(), months };
}

function timelineRow(project, start, end) {
  const span = end - start;
  const pct = (iso) => {
    if (!iso) return null;
    const t = Date.parse(`${iso}T00:00:00Z`);
    if (Number.isNaN(t)) return null;
    return Math.max(0, Math.min(100, ((t - start) / span) * 100));
  };

  const m = project.milestones || {};
  const left = pct(m.kickoff) ?? 0;
  const right = pct(m.supportEnd) ?? Math.min(100, left + 6);
  const todayPct = pct(new Date().toISOString().slice(0, 10)) ?? 0;

  const dot = (iso, color, label) => {
    const at = pct(iso);
    return at === null ? "" : `<div class="track-dot" style="left:${at}%;background:${color};" title="${escapeHtml(label)} ${escapeHtml(iso)}"></div>`;
  };

  return `<div class="timeline-row">
    <div style="min-width:0;">
      <div class="timeline-name" title="${escapeHtml(project.name)}">${escapeHtml(project.name)}</div>
      <div class="timeline-phase">${escapeHtml(project.phase || "")}${project.note ? " · " + escapeHtml(project.note) : ""}</div>
    </div>
    <div class="track">
      <div class="track-grid"><span></span><span></span><span></span></div>
      <div class="track-today" style="left:${todayPct}%"></div>
      <div class="track-bar" style="left:${left}%;width:${Math.max(1.5, right - left)}%"></div>
      ${dot(m.kickoff, "var(--denim-blue)", "Kickoff")}
      ${dot(m.implementation, "var(--burnt-orange)", "Implementation")}
      ${dot(m.walkthrough, "var(--sunset-yellow)", "Walkthrough")}
      ${m.supportEnd ? `<div class="track-end" style="left:${right}%">ends ${escapeHtml(m.supportEnd.slice(5))}</div>` : ""}
    </div>
  </div>`;
}

function appendWarnings(root, warnings) {
  if (!warnings || !warnings.length) return;
  const note = document.createElement("div");
  note.className = "warning-note";
  note.textContent = `Some sources didn't answer: ${warnings.join("; ")}`;
  root.appendChild(note);
}


// ---------- Editing ----------

let toastTimer = null;
let showOverdue = false;

function showToast(message, { actionLabel, onAction, error = false, ms = 8000 } = {}) {
  document.querySelector(".toast")?.remove();
  clearTimeout(toastTimer);

  const toast = document.createElement("div");
  toast.className = "toast" + (error ? " error" : "");
  const text = document.createElement("span");
  text.textContent = message;
  toast.appendChild(text);

  if (actionLabel) {
    const button = document.createElement("button");
    button.textContent = actionLabel;
    button.addEventListener("click", () => {
      toast.remove();
      clearTimeout(toastTimer);
      onAction();
    });
    toast.appendChild(button);
  }

  document.body.appendChild(toast);
  toastTimer = setTimeout(() => toast.remove(), ms);
}

function rowFor(taskId) {
  return document.querySelector(`[data-task-row="${CSS.escape(taskId)}"]`);
}

function moneyRowFor(key) {
  return document.querySelector(`[data-money-row="${CSS.escape(key)}"]`);
}

/**
 * The friction gate on money. Tasks are cheap to undo and go through on the
 * first tap; anything that touches an invoice or a bill has to be said twice.
 * Resolves true when confirmed, false on cancel, Escape, or a backdrop tap.
 */
function confirmAction(message, confirmLabel = "Yes, do it") {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `<div class="confirm-box" role="dialog" aria-modal="true">
      <p class="confirm-text"></p>
      <div class="confirm-actions">
        <button type="button" class="confirm-cancel">Cancel</button>
        <button type="button" class="confirm-ok"></button>
      </div>
    </div>`;
    overlay.querySelector(".confirm-text").textContent = message;
    overlay.querySelector(".confirm-ok").textContent = confirmLabel;

    let settled = false;
    const close = (answer) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(answer);
    };
    const onKey = (event) => {
      if (event.key === "Escape") close(false);
    };

    overlay.querySelector(".confirm-ok").addEventListener("click", () => close(true));
    overlay.querySelector(".confirm-cancel").addEventListener("click", () => close(false));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(false);
    });
    document.addEventListener("keydown", onKey);

    document.body.appendChild(overlay);
    overlay.querySelector(".confirm-ok").focus();
  });
}

/** The urgent bar has a button rather than a checkbox — same write underneath. */
async function completeFromBar(button) {
  const taskId = button.dataset.completeNow;
  const bar = button.closest(".urgent-bar");
  button.disabled = true;
  button.textContent = "Saving...";
  try {
    const result = await api(`/api/tasks/${encodeURIComponent(taskId)}/complete`, { method: "POST" });
    bar?.remove();
    showToast("Marked complete in ClickUp.", {
      actionLabel: "Undo",
      onAction: () => reopenTask(taskId, result.previousStatus).then(() => loadSection("tasks")),
    });
    loadSection("tasks");
  } catch (err) {
    button.disabled = false;
    button.textContent = "Mark done";
    showToast(`Couldn't complete that: ${err.message}`, { error: true });
  }
}

// ---------- Adding things ----------

/**
 * One inline form for the three + buttons. It drops into the card it was opened
 * from rather than a modal, so the row it will join stays in view.
 */
const ADD_FORMS = {
  invoice: {
    title: "Expected payment",
    path: "/api/money/invoices",
    section: "money",
    fields: [
      { name: "client", label: "From", type: "text", placeholder: "Client name", full: true },
      { name: "amount", label: "Amount", type: "number", placeholder: "2500", step: "0.01" },
      { name: "due", label: "Expected", type: "date" },
    ],
    done: (v) => `Added ${v.client} for ${v.due || "no date"}.`,
  },
  bill: {
    title: "Recurring bill",
    path: "/api/money/bills",
    section: "money",
    fields: [
      { name: "name", label: "Name", type: "text", placeholder: "Adobe", full: true },
      { name: "amount", label: "Amount", type: "number", placeholder: "60", step: "0.01" },
      {
        name: "frequency",
        label: "How often",
        type: "select",
        options: ["Monthly", "Weekly", "Every 2 Weeks", "Quarterly", "One-time"],
      },
      { name: "dayOfMonth", label: "Day of month", type: "number", min: "1", max: "31", when: ["Monthly", "Quarterly"] },
      {
        name: "weekday",
        label: "Weekday",
        type: "select",
        options: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        when: ["Weekly"],
      },
      { name: "anchor", label: "Starting", type: "date", when: ["Every 2 Weeks", "One-time", "Quarterly"] },
    ],
    done: (v) => `Added ${v.name}.`,
  },
  task: {
    title: "Content task",
    path: "/api/tasks",
    section: "tasks",
    fields: [
      { name: "title", label: "What is it?", type: "text", placeholder: "W6 carousel", full: true },
      { name: "due", label: "Due", type: "date" },
      {
        name: "contentType",
        label: "Type",
        type: "select",
        options: ["", "Thread", "Carousel", "Reel", "Post", "Story", "Email", "Blog", "YouTube"],
      },
    ],
    done: (v) => `Added "${v.title}".`,
  },
};

function mountAddForm(key, button) {
  const spec = ADD_FORMS[key];
  if (!spec) return;
  document.querySelector(".add-form")?.remove();

  const card = button.closest(".card") || button.parentElement;
  const form = document.createElement("form");
  form.className = "add-form";
  form.dataset.addForm = key;

  const paint = () => {
    const current = new FormData(form);
    const freq = current.get("frequency") || spec.fields.find((f) => f.name === "frequency")?.options?.[0];
    const visible = spec.fields.filter((f) => !f.when || f.when.includes(freq));
    form.innerHTML = `<div class="eyebrow" style="color:var(--burnt-orange);margin-bottom:12px;">${escapeHtml(spec.title)}</div>
      <div class="field-error" hidden></div>
      ${visible
        .map(
          (f) => `<div${f.full ? ' style="grid-column:1/-1;"' : ""}>
            <label class="card-sub" style="display:block;margin-bottom:4px;">${escapeHtml(f.label)}</label>
            ${
              f.type === "select"
                ? `<select name="${f.name}">${f.options.map((o) => `<option value="${escapeHtml(o)}"${String(current.get(f.name)) === o ? " selected" : ""}>${escapeHtml(o || "None")}</option>`).join("")}</select>`
                : `<input name="${f.name}" type="${f.type}" ${f.placeholder ? `placeholder="${escapeHtml(f.placeholder)}"` : ""} ${f.step ? `step="${f.step}"` : ""} ${f.min ? `min="${f.min}"` : ""} ${f.max ? `max="${f.max}"` : ""} value="${escapeHtml(String(current.get(f.name) || ""))}" autocomplete="off">`
            }
          </div>`,
        )
        .join("")
        .replace(/^/, '<div class="add-form-row">')}</div>
      <div class="add-form-actions">
        <button type="submit" class="primary">Add</button>
        <button type="button" data-cancel-add="1">Cancel</button>
      </div>`;
  };

  paint();
  card.appendChild(form);
  form.querySelector("input, select")?.focus();

  // Frequency decides which anchor field the bill needs, so redraw on change.
  form.addEventListener("change", (event) => {
    if (event.target.name === "frequency") paint();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    const submit = form.querySelector("button[type=submit]");
    const error = form.querySelector(".field-error");
    submit.disabled = true;
    submit.textContent = "Adding...";
    error.hidden = true;

    // Empty strings would fail number and date validation upstream; drop them.
    for (const [k, v] of Object.entries(values)) if (v === "") delete values[k];

    try {
      await api(spec.path, { method: "POST", body: JSON.stringify(values) });
      form.remove();
      showToast(spec.done(values), { ms: 5000 });
      loadSection(spec.section);
      if (monthData) loadMonth(monthKey);
    } catch (err) {
      submit.disabled = false;
      submit.textContent = "Add";
      error.textContent = err.message;
      error.hidden = false;
    }
  });
}

// ---------- Money editing ----------

async function markInvoicePaid(checkbox) {
  const id = checkbox.dataset.invoicePaid;
  const who = checkbox.dataset.label || "this invoice";
  const amount = checkbox.dataset.amount;
  const row = moneyRowFor(`invoice:${id}`);

  const ok = await confirmAction(
    amount ? `Mark ${amount} from ${who} as received?` : `Mark ${who} as paid?`,
    "Mark paid",
  );
  if (!ok) {
    checkbox.checked = false;
    return;
  }

  checkbox.disabled = true;
  row?.classList.add("saving");
  try {
    const result = await api(`/api/money/invoices/${encodeURIComponent(id)}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "Paid" }),
    });
    row?.classList.remove("saving");
    row?.classList.add("done");
    showToast("Marked paid in Airtable.", {
      actionLabel: "Undo",
      onAction: () => restoreInvoiceStatus(id, result.previousStatus),
    });
  } catch (err) {
    // Airtable did not change, so neither should the row.
    checkbox.checked = false;
    checkbox.disabled = false;
    row?.classList.remove("saving");
    showToast(`Couldn't mark that paid: ${err.message}`, { error: true });
  }
}

async function restoreInvoiceStatus(id, previousStatus) {
  const row = moneyRowFor(`invoice:${id}`);
  if (!previousStatus) {
    showToast("That invoice had no status before, so put it back in Airtable.", { error: true });
    return;
  }
  row?.classList.add("saving");
  try {
    await api(`/api/money/invoices/${encodeURIComponent(id)}/status`, {
      method: "POST",
      body: JSON.stringify({ status: previousStatus }),
    });
    row?.classList.remove("saving", "done");
    const checkbox = row?.querySelector(".money-check");
    if (checkbox) {
      checkbox.checked = false;
      checkbox.disabled = false;
    }
    showToast(`Back to "${previousStatus}".`, { ms: 4000 });
  } catch (err) {
    row?.classList.remove("saving");
    showToast(`Couldn't undo that: ${err.message}`, { error: true });
  }
}

async function markBillPaid(checkbox) {
  const id = checkbox.dataset.billPaid;
  const due = checkbox.dataset.due;
  const previous = checkbox.dataset.prev || null;
  const name = checkbox.dataset.label || "this bill";
  const amount = checkbox.dataset.amount;
  const row = moneyRowFor(`bill:${id}:${due}`);

  const ok = await confirmAction(
    amount ? `Mark the ${amount} ${name} bill due ${due} as paid?` : `Mark ${name} due ${due} as paid?`,
    "Mark paid",
  );
  if (!ok) {
    checkbox.checked = false;
    return;
  }

  checkbox.disabled = true;
  row?.classList.add("saving");
  try {
    await api(`/api/money/bills/${encodeURIComponent(id)}/paid`, {
      method: "POST",
      body: JSON.stringify({ due }),
    });
    row?.classList.remove("saving");
    row?.classList.add("done");
    showToast("Recorded as paid. The next one still comes due on schedule.", {
      actionLabel: "Undo",
      onAction: () => restorePaidThrough(id, due, previous),
    });
  } catch (err) {
    checkbox.checked = false;
    checkbox.disabled = false;
    row?.classList.remove("saving");
    showToast(`Couldn't record that: ${err.message}`, { error: true });
  }
}

async function restorePaidThrough(id, due, previous) {
  const row = moneyRowFor(`bill:${id}:${due}`);
  row?.classList.add("saving");
  try {
    await api(`/api/money/bills/${encodeURIComponent(id)}/paid-through`, {
      method: "POST",
      body: JSON.stringify({ paidThrough: previous }),
    });
    row?.classList.remove("saving", "done");
    const checkbox = row?.querySelector(".money-check");
    if (checkbox) {
      checkbox.checked = false;
      checkbox.disabled = false;
    }
    showToast("Put back.", { ms: 4000 });
  } catch (err) {
    row?.classList.remove("saving");
    showToast(`Couldn't undo that: ${err.message}`, { error: true });
  }
}

/** Move an invoice's expected date. Same picker as tasks, plus the confirm. */
async function editInvoiceDue(button) {
  const id = button.dataset.invoiceDue;
  const current = button.dataset.dueValue || "";
  const input = document.createElement("input");
  input.type = "date";
  input.className = "due-input";
  input.value = current;
  button.replaceWith(input);
  input.focus();
  if (input.showPicker) {
    try {
      input.showPicker();
    } catch {
      /* not allowed in this context; the field is still usable */
    }
  }

  let settled = false;
  const restore = (label, value) => {
    if (settled) return;
    settled = true;
    button.textContent = label;
    button.dataset.dueValue = value;
    input.replaceWith(button);
  };

  const save = async () => {
    if (settled) return;
    const value = input.value;
    if (value === current) {
      restore(button.textContent, current);
      return;
    }
    settled = true;
    input.disabled = true;

    const ok = await confirmAction(
      value ? `Move the expected date to ${value} in Airtable?` : "Clear the expected date in Airtable?",
      "Move it",
    );
    if (!ok) {
      settled = false;
      restore(current || "no date", current);
      return;
    }

    try {
      await api(`/api/money/invoices/${encodeURIComponent(id)}/due`, {
        method: "POST",
        body: JSON.stringify({ due: value || null }),
      });
      settled = false;
      restore(value || "no date", value);
      showToast("Expected date updated.", { ms: 4000 });
    } catch (err) {
      settled = false;
      restore(current || "no date", current);
      showToast(`Couldn't move that date: ${err.message}`, { error: true });
    }
  };

  input.addEventListener("change", save);
  input.addEventListener("blur", save);
}

async function completeTask(taskId, checkbox) {
  const row = rowFor(taskId);
  checkbox.disabled = true;
  row?.classList.add("saving");

  try {
    const result = await api(`/api/tasks/${encodeURIComponent(taskId)}/complete`, { method: "POST" });
    row?.classList.remove("saving");
    row?.classList.add("done");
    showToast("Marked complete in ClickUp.", {
      actionLabel: "Undo",
      onAction: () => reopenTask(taskId, result.previousStatus),
    });
  } catch (err) {
    // Put the row back the way it was — the task did not change in ClickUp.
    checkbox.checked = false;
    checkbox.disabled = false;
    row?.classList.remove("saving");
    showToast(`Couldn't complete that: ${err.message}`, { error: true });
  }
}

async function reopenTask(taskId, previousStatus) {
  if (!previousStatus) {
    showToast("I don't know what status it had before, so open it in ClickUp.", { error: true });
    return;
  }
  const row = rowFor(taskId);
  row?.classList.add("saving");
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}/status`, {
      method: "POST",
      body: JSON.stringify({ status: previousStatus }),
    });
    row?.classList.remove("saving", "done");
    const checkbox = row?.querySelector(".task-check");
    if (checkbox) {
      checkbox.checked = false;
      checkbox.disabled = false;
    }
    showToast(`Back to "${previousStatus}".`, { ms: 4000 });
  } catch (err) {
    row?.classList.remove("saving");
    showToast(`Couldn't undo that: ${err.message}`, { error: true });
  }
}

/** Swap the due-date label for a native date input, and save on pick. */
function editDueDate(button) {
  const taskId = button.dataset.dueFor;
  const input = document.createElement("input");
  input.type = "date";
  input.className = "due-input";
  input.value = button.dataset.dueValue || "";
  button.replaceWith(input);
  input.focus();
  if (input.showPicker) {
    try {
      input.showPicker();
    } catch {
      /* not allowed in this context; the field is still usable */
    }
  }

  let settled = false;
  const restore = (label, value) => {
    if (settled) return;
    settled = true;
    button.textContent = label;
    button.dataset.dueValue = value;
    input.replaceWith(button);
  };

  const save = async () => {
    if (settled) return;
    const value = input.value;
    if (value === (button.dataset.dueValue || "")) {
      restore(button.textContent, button.dataset.dueValue || "");
      return;
    }
    settled = true;
    input.disabled = true;
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/due`, {
        method: "POST",
        body: JSON.stringify({ due: value || null }),
      });
      settled = false;
      restore(value || "no date", value);
      showToast("Due date updated.", { ms: 4000 });
    } catch (err) {
      settled = false;
      restore(button.textContent, button.dataset.dueValue || "");
      showToast(`Couldn't move that date: ${err.message}`, { error: true });
    }
  };

  input.addEventListener("change", save);
  input.addEventListener("blur", save);
}


// ---------- Calendar view ----------

let monthData = null;
let monthKey = null;      // "2026-08"
let monthLoading = false;
let openCreateDate = null;

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const KIND_LABELS = {
  event: "Calls",
  milestone: "Project milestones",
  content: "Content",
  payment: "Payments",
  bill: "Bills",
};

/** "2026-08" shifted by whole months, without tripping over December. */
function shiftMonthKey(key, months) {
  const [year, month] = key.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + months, 1));
  return shifted.toISOString().slice(0, 7);
}

function monthLabel(key) {
  const [year, month] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

async function loadMonth(key) {
  monthKey = key;
  monthLoading = true;
  renderCalendar();
  try {
    monthData = await api(`/api/dashboard/month?month=${encodeURIComponent(key)}`);
    monthKey = monthData.month || key;
  } catch (err) {
    monthData = { error: err.message };
  } finally {
    monthLoading = false;
    renderCalendar();
  }
}

function renderCalendar() {
  const root = $("calendarView");
  if (!root) return;
  root.innerHTML = "";

  const head = document.createElement("div");
  head.className = "cal-head";
  head.innerHTML = `<div class="cal-title">${escapeHtml(monthKey ? monthLabel(monthKey) : "Calendar")}</div>
    <div class="cal-nav">
      <button data-month-step="-1">&larr;</button>
      <button data-month-today="1">Today</button>
      <button data-month-step="1">&rarr;</button>
    </div>`;
  root.appendChild(head);

  if (monthLoading && !monthData) {
    root.appendChild(loadingCard("Loading the month..."));
    return;
  }
  if (monthData?.error) {
    root.appendChild(errorCard(monthData.error, "month"));
    return;
  }
  if (!monthData) return;

  const layout = document.createElement("div");
  layout.className = "calendar-layout";

  // --- grid ---
  const grid = document.createElement("div");
  grid.className = "cal-grid";
  const weekdays = WEEKDAY_LABELS.map((day) => `<div class="cal-weekday">${day}</div>`).join("");
  const weeks = (monthData.weeks || [])
    .map((week) => `<div class="cal-week">${week.map(dayCell).join("")}</div>`)
    .join("");
  grid.innerHTML = `<div class="cal-weekdays">${weekdays}</div>${weeks}`;
  layout.appendChild(grid);

  const legend = document.createElement("div");
  legend.className = "cal-legend";
  legend.innerHTML = Object.entries(KIND_LABELS)
    .map(
      ([kind, label]) =>
        `<span><i class="cal-swatch cal-item-${kind}" style="border-left-width:9px;border-left-style:solid"></i>${escapeHtml(label)}</span>`,
    )
    .join("");
  grid.appendChild(legend);

  // --- rail ---
  const rail = document.createElement("div");
  rail.className = "cal-rail";
  const unscheduled = monthData.unscheduled || [];
  const railRows = unscheduled.length
    ? unscheduled
        .map(
          (item) => `<div class="rail-item" data-rail-id="${escapeHtml(item.id)}">
            <div class="rail-title">${escapeHtml(item.title)}</div>
            <div class="rail-meta">${[item.platform, item.stage].filter(Boolean).map(escapeHtml).join(" — ")}</div>
            <button class="rail-schedule" data-schedule="${escapeHtml(item.id)}">Give it a date</button>
          </div>`,
        )
        .join("")
    : '<div class="empty-row">Everything has a date.</div>';
  rail.innerHTML = `<h3>Unscheduled content${unscheduled.length ? ` (${unscheduled.length})` : ""}</h3>${railRows}`;
  layout.appendChild(rail);

  root.appendChild(layout);

  const warnings = monthData.warnings || [];
  if (warnings.length) {
    const note = document.createElement("div");
    note.className = "warning-note";
    note.textContent = `Some sources didn't answer: ${warnings.join("; ")}`;
    root.appendChild(note);
  }

  if (openCreateDate) mountCreateForm(openCreateDate);
}

function dayCell(date) {
  const items = (monthData.days || {})[date] || [];
  const outside = date < monthData.first || date > monthData.last;
  const today = date === monthData.today;
  const shown = items.slice(0, 3);
  const rest = items.length - shown.length;

  const chips = shown
    .map((item) => {
      const label = item.meta ? `${item.title} · ${item.meta}` : item.title;
      return `<div class="cal-item cal-item-${escapeHtml(item.kind)}" title="${escapeHtml(label)}">${escapeHtml(item.title)}</div>`;
    })
    .join("");

  return `<div class="cal-day${outside ? " outside" : ""}${today ? " today" : ""}" data-day="${escapeHtml(date)}">
    <div class="cal-daynum">${Number(date.slice(8, 10))}</div>
    ${chips}${rest > 0 ? `<div class="cal-more">+${rest} more</div>` : ""}
  </div>`;
}

/** The create form drops into the rail so it never resizes the grid mid-click. */
function mountCreateForm(date) {
  const rail = document.querySelector(".cal-rail");
  if (!rail || !monthData?.canCreate) return;
  document.querySelector(".cal-create")?.remove();

  const types = monthData.contentTypes || [];
  const form = document.createElement("form");
  form.className = "cal-create";
  form.innerHTML = `<h3>New task — ${escapeHtml(date)}</h3>
    <input type="text" id="createTitle" placeholder="What is it?" maxlength="200" autocomplete="off">
    ${types.length ? `<select id="createType"><option value="">No content type</option>${types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("")}</select>` : ""}
    <div class="cal-create-actions">
      <button type="submit" class="primary">Add to Content Management</button>
      <button type="button" data-cancel-create="1">Cancel</button>
    </div>`;
  rail.prepend(form);
  form.querySelector("#createTitle").focus();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = form.querySelector("#createTitle").value.trim();
    if (!title) return;
    const contentType = form.querySelector("#createType")?.value || "";
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    submit.textContent = "Adding...";
    try {
      const result = await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ title, due: date, contentType: contentType || undefined }),
      });
      openCreateDate = null;
      showToast(`Added "${result.task.title}" on ${date}.`, { ms: 5000 });
      await loadMonth(monthKey);
      // The pipeline card reads the same list, so keep it honest.
      loadSection("tasks");
    } catch (err) {
      submit.disabled = false;
      submit.textContent = "Add to Content Management";
      showToast(`Couldn't create that: ${err.message}`, { error: true });
    }
  });
}

/** Schedule an undated content task straight from the rail. */
function scheduleRailItem(button) {
  const taskId = button.dataset.schedule;
  const row = document.querySelector(`[data-rail-id="${CSS.escape(taskId)}"]`);
  const input = document.createElement("input");
  input.type = "date";
  input.className = "due-input";
  button.replaceWith(input);
  input.focus();
  if (input.showPicker) {
    try {
      input.showPicker();
    } catch {
      /* not allowed here; the field still works */
    }
  }

  let settled = false;
  const restore = () => {
    if (settled) return;
    settled = true;
    input.replaceWith(button);
  };

  const save = async () => {
    if (settled) return;
    const value = input.value;
    if (!value) return restore();
    settled = true;
    row?.classList.add("saving");
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/due`, {
        method: "POST",
        body: JSON.stringify({ due: value }),
      });
      showToast(`Scheduled for ${value}.`, { ms: 4000 });
      await loadMonth(monthKey);
      loadSection("tasks");
    } catch (err) {
      settled = false;
      row?.classList.remove("saving");
      restore();
      showToast(`Couldn't schedule that: ${err.message}`, { error: true });
    }
  };

  input.addEventListener("change", save);
  input.addEventListener("blur", save);
}

const VIEW_IDS = { money: "moneyView", work: "workView", clients: "clientsView", calendar: "calendarView" };

function showView(view) {
  if (!VIEW_IDS[view]) view = "money";
  activeView = view;
  localStorage.setItem("homebase-view", view);
  // The calendar and the client timeline both want the chat column's width.
  document.body.classList.toggle("wide-mode", view === "calendar" || view === "clients");

  for (const [name, id] of Object.entries(VIEW_IDS)) $(id).hidden = name !== view;
  for (const button of document.querySelectorAll(".view-btn")) {
    button.className = "view-btn" + (button.dataset.view === view ? " active" : "");
  }

  if (view === "calendar" && !monthData && !monthLoading) {
    loadMonth(monthKey || new Date().toISOString().slice(0, 7));
    return;
  }
  render();
}

// ---------- Chat ----------

function appendMessage(role, text) {
  const container = $("chatMessages");
  container.querySelector(".chat-empty")?.remove();
  const div = document.createElement("div");
  div.className = `msg msg-${role}`;
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

async function sendChat() {
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  $("sendBtn").disabled = true;

  appendMessage("user", text);
  chatHistory.push({ role: "user", content: text });

  const container = $("chatMessages");
  const thinking = document.createElement("div");
  thinking.className = "msg-thinking";
  thinking.textContent = "Checking your tools...";
  container.appendChild(thinking);
  container.scrollTop = container.scrollHeight;

  try {
    const data = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: chatHistory }),
    });
    thinking.remove();
    const reply = data.reply || "I didn't get a usable answer back — try rephrasing.";
    appendMessage("assistant", reply);
    chatHistory.push({ role: "assistant", content: reply });
    localStorage.setItem("homebase-chat", JSON.stringify(chatHistory.slice(-20)));
  } catch (err) {
    thinking.remove();
    appendMessage("assistant", `Something went wrong reaching your tools: ${err.message}`);
    chatHistory.pop();
  } finally {
    $("sendBtn").disabled = false;
  }
}

// ---------- Sign-in gate ----------

function showGate() {
  $("gate").classList.add("visible");
  $("gatePassword").focus();
}

function hideGate() {
  $("gate").classList.remove("visible");
}

// ---------- Wiring ----------

function showMobileTab(tab) {
  $("dashboardCol").className = tab === "dashboard" ? "active-mobile" : "";
  $("chatCol").className = tab === "chat" ? "active-mobile" : "";
  $("tabDashBtn").className = "tab-btn" + (tab === "dashboard" ? " active" : "");
  $("tabChatBtn").className = "tab-btn" + (tab === "chat" ? " active" : "");
}

$("refreshBtn").addEventListener("click", refresh);
$("sendBtn").addEventListener("click", sendChat);
$("tabDashBtn").addEventListener("click", () => showMobileTab("dashboard"));
$("tabChatBtn").addEventListener("click", () => showMobileTab("chat"));

$("chatInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendChat();
  }
});

for (const button of document.querySelectorAll(".view-btn")) {
  button.addEventListener("click", () => showView(button.dataset.view));
}

$("calendarView").addEventListener("click", (event) => {
  const retry = event.target.dataset?.retry;
  if (retry === "month") {
    monthData = null;
    loadMonth(monthKey);
    return;
  }

  const step = event.target.dataset?.monthStep;
  if (step) {
    openCreateDate = null;
    monthData = null;
    loadMonth(shiftMonthKey(monthKey, Number(step)));
    return;
  }
  if (event.target.dataset?.monthToday) {
    openCreateDate = null;
    monthData = null;
    loadMonth(new Date().toISOString().slice(0, 7));
    return;
  }

  if (event.target.dataset?.cancelCreate) {
    openCreateDate = null;
    document.querySelector(".cal-create")?.remove();
    return;
  }

  const schedule = event.target.closest(".rail-schedule");
  if (schedule) {
    scheduleRailItem(schedule);
    return;
  }

  // A day opens the create form for that date. Done last so the controls above
  // aren't swallowed by the cell they sit in.
  const day = event.target.closest(".cal-day");
  if (day) {
    openCreateDate = day.dataset.day;
    mountCreateForm(openCreateDate);
  }
});

// One delegated pair on the column, so every tab's controls work without each
// renderer wiring its own listeners.
$("dashboardCol").addEventListener("click", (event) => {
  const key = event.target.dataset?.retry;
  if (key) {
    if (SECTIONS.includes(key)) loadSection(key);
    return;
  }

  const add = event.target.closest("[data-add]");
  if (add) return mountAddForm(add.dataset.add, add);

  const cancel = event.target.closest("[data-cancel-add]");
  if (cancel) return document.querySelector(".add-form")?.remove();

  const toggle = event.target.closest("[data-toggle-overdue]");
  if (toggle) {
    showOverdue = !showOverdue;
    render();
    return;
  }

  const now = event.target.closest("[data-complete-now]");
  if (now) return completeFromBar(now);

  const dueButton = event.target.closest(".due-control");
  if (!dueButton) return;
  if (dueButton.dataset.invoiceDue) editInvoiceDue(dueButton);
  else editDueDate(dueButton);
});

$("dashboardCol").addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[type=checkbox]");
  if (!checkbox || !checkbox.checked) return;
  if (checkbox.dataset.complete) completeTask(checkbox.dataset.complete, checkbox);
  else if (checkbox.dataset.invoicePaid) markInvoicePaid(checkbox);
  else if (checkbox.dataset.billPaid) markBillPaid(checkbox);
});

$("gateForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("gateError").textContent = "";
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: $("gatePassword").value }),
    });
    if (!response.ok) {
      $("gateError").textContent = "That password didn't work.";
      return;
    }
    $("gatePassword").value = "";
    hideGate();
    start();
  } catch {
    $("gateError").textContent = "Couldn't reach the server.";
  }
});

const focusEl = $("focusText");
let focusTimer = null;
focusEl.addEventListener("input", () => {
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => localStorage.setItem("homebase-focus", focusEl.textContent), 600);
});

// ---------- Init ----------

async function start() {
  // Reopen on whichever tab was last used rather than always on Money.
  showView(localStorage.getItem("homebase-view") || "money");

  // Paint the last good snapshot first so a reload isn't a blank wait, then
  // pull live data over the top.
  const cached = await Promise.all(SECTIONS.map((key) => loadSection(key, { cached: true })));
  if (cached.some(Boolean)) {
    for (const [index, key] of SECTIONS.entries()) if (cached[index]) status[key] = "done";
    render();
    $("asOfLabel").textContent = "Last snapshot — refreshing";
  }

  refresh();
}

async function init() {
  focusEl.textContent = localStorage.getItem("homebase-focus") || "";
  try {
    chatHistory = JSON.parse(localStorage.getItem("homebase-chat") || "[]");
    chatHistory.forEach((message) => appendMessage(message.role, message.content));
  } catch {
    chatHistory = [];
  }

  const session = await fetch("/api/session", { credentials: "same-origin" })
    .then((response) => response.json())
    .catch(() => ({ signedIn: false }));

  if (session.signedIn) start();
  else showGate();
}

init();
