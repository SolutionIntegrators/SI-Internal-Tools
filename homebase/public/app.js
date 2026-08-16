// Home Base frontend. The dashboard tiles are rendered from whatever the
// Worker computed — no parsing, no model output to second-guess.

const SECTIONS = ["money", "tasks", "calendar"];

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

function render() {
  const grid = $("dashboardGrid");
  grid.innerHTML = "";
  const d = dashboard;

  const moneyDone = status.money === "done";
  const tasksDone = status.tasks === "done";
  const calDone = status.calendar === "done";

  const revenue = d.revenue || {};
  const goal = revenue.goal || 7500;
  const current = revenue.current || 0;
  const percent = goal > 0 ? Math.min(100, Math.round((current / goal) * 100)) : 0;
  const tickets = d.supportTickets || {};
  const ticketsOpen = tickets.openCount || 0;
  const ticketsOverdue = tickets.overdue || [];
  const dueSoonCount = (d.myTasksSoon || []).length;
  const nextCall = (d.nextCalls || [])[0];

  const vitals = document.createElement("div");
  vitals.className = "vitals-row";
  vitals.innerHTML = `
    <div class="vital"><div class="vital-num">${moneyDone ? percent + "%" : "—"}</div><div class="vital-label">of $${goal.toLocaleString()} weekly goal</div></div>
    <div class="vital"><div class="vital-num${ticketsOverdue.length ? " alert" : ""}">${tasksDone ? ticketsOpen : "—"}</div><div class="vital-label">tickets open${ticketsOverdue.length ? " — " + ticketsOverdue.length + " past 2 days" : ""}</div></div>
    <div class="vital"><div class="vital-num${dueSoonCount ? " alert" : ""}">${tasksDone ? dueSoonCount : "—"}</div><div class="vital-label">tasks due next 3 days</div></div>
    <div class="vital"><div class="vital-num" style="font-size:16px;">${calDone ? (nextCall ? escapeHtml(nextCall.time) : "—") : "—"}</div><div class="vital-label">${calDone ? (nextCall ? escapeHtml(nextCall.title) : "no calls on the books") : "loading"}</div></div>
  `;
  grid.appendChild(vitals);

  // This Week's Money
  let moneyCards;
  if (status.money === "error") {
    moneyCards = [errorCard(errors.money, "money")];
  } else if (!moneyDone) {
    moneyCards = [loadingCard("Loading revenue, payments, and bills from Airtable...")];
  } else {
    const revenueCard = document.createElement("div");
    revenueCard.className = "card";
    revenueCard.innerHTML = `<h2>Revenue This Week</h2>
      <div class="revenue-figures"><span class="revenue-current">$${current.toLocaleString()}</span><span class="revenue-goal-label">of $${goal.toLocaleString()} goal</span></div>
      <div class="revenue-progress-track"><div class="revenue-progress-fill" style="width:${percent}%"></div></div>
      <div class="revenue-note">${escapeHtml(revenue.note || "")}</div>`;

    moneyCards = [
      revenueCard,
      buildCard(
        "Upcoming Payments",
        d.upcomingPayments,
        (p) => `<div class="row"><span class="row-title">${escapeHtml(p.client)}${p.amount ? " — " + escapeHtml(p.amount) : ""}</span><div class="row-sub">${escapeHtml(p.expected || "")}</div></div>`,
      ),
      buildCard(
        "Upcoming Bills — Next 7 Days",
        d.upcomingBills,
        (b) => `<div class="row"><span class="row-title">${escapeHtml(b.name)}${b.amount ? " — " + escapeHtml(b.amount) : ""}</span><div class="row-sub">${escapeHtml(b.due || "")}</div></div>`,
      ),
    ];
  }
  grid.appendChild(buildSection("This Week's Money", moneyCards, "cols-3"));

  // Needs You
  let needsCards;
  if (status.tasks === "error") {
    needsCards = [errorCard(errors.tasks, "tasks")];
  } else if (!tasksDone) {
    needsCards = [loadingCard("Loading tasks and tickets from ClickUp...")];
  } else {
    const ticketsCard = document.createElement("div");
    ticketsCard.className = "card";
    const ticketRows = ticketsOverdue.length
      ? ticketsOverdue
          .map(
            (t) => `<div class="row"><span class="row-title">${escapeHtml(t.title)}<span class="pill pill-needs_attention">${escapeHtml(String(t.daysOpen ?? "2+"))}d open</span></span><div class="row-sub">${escapeHtml(t.client || "")}</div></div>`,
          )
          .join("")
      : '<div class="empty-row">Nothing open past 2 days.</div>';
    ticketsCard.innerHTML = `<h2>Support Tickets — ${ticketsOpen} Open</h2>${ticketRows}`;

    needsCards = [
      buildCard(
        "My Tasks — Next 3 Days",
        d.myTasksSoon,
        (t) => `<div class="row"><span class="row-title">${escapeHtml(t.title)}</span><div class="row-sub">${escapeHtml(t.client || "")}${t.due ? " · due " + escapeHtml(t.due) : ""}</div></div>`,
      ),
      buildCard(
        "Ready for Review",
        d.readyForReview,
        (r) => `<div class="row"><span class="row-title">${escapeHtml(r.title)}</span><div class="row-sub">${escapeHtml(r.client || "")}</div></div>`,
      ),
      ticketsCard,
    ];
  }
  grid.appendChild(buildSection("Needs You", needsCards, "cols-3"));

  // Calendar
  let calendarCards;
  if (status.calendar === "error") {
    calendarCards = [errorCard(errors.calendar, "calendar")];
  } else if (!calDone) {
    calendarCards = [loadingCard("Loading calendar...")];
  } else {
    calendarCards = [
      buildCard("Next 2 Calls", d.nextCalls, (c) => `<div class="row"><span class="row-title">${escapeHtml(c.time)}</span><div class="row-sub">${escapeHtml(c.title)}</div></div>`),
      buildCard("Today", d.calendarToday, (e) => `<div class="row"><span class="row-title">${escapeHtml(e.time)}</span><div class="row-sub">${escapeHtml(e.title)}</div></div>`),
      buildCard("This Week", d.calendarWeek, (e) => `<div class="row"><span class="row-title">${escapeHtml(e.day)}</span><div class="row-sub">${escapeHtml(e.title)}</div></div>`),
    ];
  }
  grid.appendChild(buildSection("Calendar", calendarCards, "cols-3"));

  // Projects & Content
  const projectCards = [];
  if (status.tasks === "error") {
    projectCards.push(errorCard(errors.tasks, "tasks"));
  } else if (!tasksDone) {
    projectCards.push(loadingCard("Loading client projects..."));
  } else {
    projectCards.push(
      buildCard(
        "Client Projects",
        d.clientProjects,
        (p) => `<div class="row"><span class="row-title">${escapeHtml(p.name)}<span class="pill pill-${escapeHtml(p.status)}">${escapeHtml(statusLabel(p.status))}</span></span><div class="row-sub">${escapeHtml(p.phase || "")}${p.note ? " — " + escapeHtml(p.note) : ""}</div></div>`,
        "span-2",
      ),
    );
  }
  if (status.money === "error") {
    projectCards.push(errorCard(errors.money, "money"));
  } else if (!moneyDone) {
    projectCards.push(loadingCard("Loading content pipeline..."));
  } else {
    projectCards.push(
      buildCard(
        "Content Pipeline",
        d.contentPipeline,
        (c) => `<div class="row"><span class="row-title">${escapeHtml(c.title)}</span><div class="row-sub">${escapeHtml(c.platform || "")} — ${escapeHtml(c.stage || "")}</div></div>`,
      ),
    );
  }
  grid.appendChild(buildSection("Projects & Content", projectCards, null));

  // A source that failed inside an otherwise-working section says so quietly,
  // rather than blanking a card that has most of its data.
  const warnings = dashboard.warnings || [];
  if (warnings.length) {
    const note = document.createElement("div");
    note.className = "warning-note";
    note.textContent = `Some sources didn't answer: ${warnings.join("; ")}`;
    grid.appendChild(note);
  }
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

$("dashboardGrid").addEventListener("click", (event) => {
  const key = event.target.dataset?.retry;
  if (key) loadSection(key);
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
  render();

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
