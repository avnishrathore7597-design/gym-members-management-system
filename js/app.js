"use strict";

/* =========================================================================
   FitCore Gym | UI controller
   Uses the backend chosen in data.js (RemoteBackend or LocalBackend).
   ========================================================================= */

const app = {
  backend: null,
  plans: [],
  page: "dashboard",
  members: [],          // members currently listed on the Members page
  memberSearch: "",
  memberFilter: "all",  // all | active | expiring | expired
  payments: [],
  paymentSearch: "",
  trainers: [],
};

const PLAN_FEATURES = {
  1: ["Gym floor access during standard hours", "Cardio and weights area", "Free fitness assessment"],
  2: ["Everything in Basic", "All group classes", "Locker access", "Sauna and steam room"],
  3: ["Everything in Standard", "24/7 access", "One personal training session a month", "Two guest passes a month"],
};

const PAGES = {
  dashboard: ["Dashboard", "Overview of members, revenue and renewals"],
  members:   ["Members", "Search, renew and manage memberships"],
  trainers:  ["Trainers", "Coaching staff and their salaries"],
  payments:  ["Payments", "Every joining fee and renewal in one place"],
  plans:     ["Plans", "Membership plans and monthly pricing"],
};

const FILTER_LABELS = { all: "All", active: "Active", expiring: "Expiring", expired: "Expired" };

// ---------- Helpers ----------

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function money(amount) {
  return "\u20B9" + Math.round(Number(amount) || 0).toLocaleString("en-IN");
}

function initials(name) {
  return (name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("")) || "?";
}

function debounce(fn, ms = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function empty(message) {
  return `<div class="empty">${esc(message)}</div>`;
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function planOptions() {
  return app.plans.map((p) => ({ value: String(p.id), label: `${p.name} · ${money(p.fee)} / month` }));
}

function monthOptions() {
  return Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1),
    label: `${i + 1} month${i ? "s" : ""}`,
  }));
}

function statusOf(m) {
  if (!m.active) return "expired";
  return m.daysLeft <= 7 ? "expiring" : "active";
}

function statusBadge(m) {
  const map = { active: ["Active", "green"], expiring: ["Expiring soon", "amber"], expired: ["Expired", "red"] };
  const [label, tone] = map[statusOf(m)];
  return `<span class="badge ${tone}">${label}</span>`;
}

function matchesFilter(m, filter) {
  if (filter === "active") return m.active;
  if (filter === "expiring") return m.active && m.daysLeft <= 7;
  if (filter === "expired") return !m.active;
  return true;
}

function fail(err) {
  toast(err.message || "Something went wrong", "error");
}

// ---------- Toasts ----------

function toast(message, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-dot"></span><span>${esc(message)}</span>`;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

// ---------- Dialogs ----------

function fieldHtml(f) {
  const required = f.required ? "required" : "";
  let control;
  if (f.type === "select") {
    const options = f.options
      .map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value) ? "selected" : ""}>${esc(o.label)}</option>`)
      .join("");
    control = `<select name="${f.name}">${options}</select>`;
  } else {
    const attrs = [
      f.placeholder ? `placeholder="${esc(f.placeholder)}"` : "",
      f.min !== undefined ? `min="${f.min}"` : "",
      f.step !== undefined ? `step="${f.step}"` : "",
    ].join(" ");
    control = `<input name="${f.name}" type="${f.type || "text"}" value="${esc(f.value ?? "")}" ${required} ${attrs} autocomplete="off">`;
  }
  const hint = f.onChange ? `<small class="hint" data-hint="${f.name}"></small>` : "";
  return `<label class="field ${f.wide ? "wide" : ""}"><span>${esc(f.label)}</span>${control}${hint}</label>`;
}

function openForm({ title, subtitle = "", fields, submitLabel = "Save", onSubmit }) {
  const form = $("#modal-form");
  $("#modal-title").textContent = title;
  $("#modal-sub").textContent = subtitle;
  $("#modal-submit").textContent = submitLabel;
  $("#modal-fields").innerHTML = fields.map(fieldHtml).join("");

  // Live hints (for example, the total fee for a renewal)
  fields.forEach((f) => {
    if (!f.onChange) return;
    const input = form.elements[f.name];
    const update = () => {
      const hint = $(`[data-hint="${f.name}"]`, form);
      if (hint) hint.textContent = f.onChange(input.value);
    };
    input.addEventListener("change", update);
    update();
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    const submit = $("#modal-submit");
    submit.disabled = true;
    submit.textContent = "Saving…";
    try {
      await onSubmit(Object.fromEntries(new FormData(form)));
      $("#modal").close();
    } catch (err) {
      fail(err);
    } finally {
      submit.disabled = false;
      submit.textContent = submitLabel;
    }
  };

  $("#modal").showModal();
  setTimeout(() => form.querySelector("input, select")?.focus(), 60);
}

function confirmDialog({ title, message, okLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const dialog = $("#confirm");
    $("#confirm-title").textContent = title;
    $("#confirm-msg").textContent = message;

    const ok = $("#confirm-ok");
    ok.textContent = okLabel;
    ok.className = `btn ${danger ? "danger" : "primary"}`;

    ok.onclick = () => { dialog.close(); resolve(true); };
    $("#confirm-cancel").onclick = () => { dialog.close(); resolve(false); };
    dialog.addEventListener("close", () => resolve(false), { once: true });

    dialog.showModal();
  });
}

// ---------- Navigation ----------

function openSidebar(open) {
  $("#sidebar").classList.toggle("open", open);
  $("#scrim").classList.toggle("show", open);
}

function go(page) {
  if (!PAGES[page]) page = "dashboard";
  app.page = page;

  $$(".page").forEach((s) => s.classList.toggle("active", s.id === `page-${page}`));
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $("#page-title").textContent = PAGES[page][0];
  $("#page-sub").textContent = PAGES[page][1];
  history.replaceState(null, "", `#${page}`);
  openSidebar(false);

  return reload();
}

// Reloads whatever page is visible
function reload() {
  const loaders = {
    dashboard: renderDashboard,
    members: renderMembers,
    trainers: renderTrainers,
    payments: renderPayments,
    plans: renderPlans,
  };
  return loaders[app.page]().catch(fail);
}

// ---------- Dashboard ----------

async function renderDashboard() {
  const [stats, members, payments] = await Promise.all([
    app.backend.stats(),
    app.backend.members(),
    app.backend.payments(),
  ]);
  app.payments = payments;

  $("#greeting").textContent = `${greeting()}, FitCore team`;

  const kpi = (label, value, foot, icon, tone) => `
    <div class="card kpi">
      <div class="kpi-icon ${tone}">${icon}</div>
      <div>
        <div class="kpi-label">${label}</div>
        <div class="kpi-value">${value}</div>
        <div class="kpi-foot">${foot}</div>
      </div>
    </div>`;

  $("#kpis").innerHTML = [
    kpi("Active members", stats.activeMembers, `${stats.totalMembers} registered in total`, "👥", "orange"),
    kpi("Expiring in 7 days", stats.expiringSoon, "Good time to send reminders", "⏳", "amber"),
    kpi("Expected monthly revenue", money(stats.expectedMonthlyRevenue), "From active memberships", "📈", "green"),
    kpi("Total collected", money(stats.totalCollected), `${payments.length} payment${payments.length === 1 ? "" : "s"} recorded`, "💰", "blue"),
  ].join("");

  const expiring = members
    .filter((m) => m.active && m.daysLeft <= 7)
    .sort((a, b) => a.daysLeft - b.daysLeft);
  $("#expiring").innerHTML = expiring.length
    ? `<ul class="rows">${expiring.slice(0, 6).map((m) => `
        <li class="row">
          <div class="avatar sm">${esc(initials(m.name))}</div>
          <div class="grow">
            <strong>${esc(m.name)}</strong>
            <div class="muted small">${esc(m.plan)} · expires ${esc(m.expiryDate)}</div>
          </div>
          <span class="badge amber">${m.daysLeft} day${m.daysLeft === 1 ? "" : "s"}</span>
        </li>`).join("")}</ul>`
    : empty("No memberships expiring this week.");

  const totalPlans = stats.basicCount + stats.standardCount + stats.premiumCount || 1;
  const bars = [
    ["Basic", stats.basicCount, "#60a5fa"],
    ["Standard", stats.standardCount, "#f97316"],
    ["Premium", stats.premiumCount, "#a855f7"],
  ];
  $("#plan-mix").innerHTML = bars.map(([name, count, color]) => `
    <div class="bar-row">
      <div class="bar-label">
        <span>${name}</span>
        <span class="muted">${count} member${count === 1 ? "" : "s"}</span>
      </div>
      <div class="bar"><div style="width:${((count / totalPlans) * 100).toFixed(1)}%;background:${color}"></div></div>
    </div>`).join("");

  $("#recent-pay").innerHTML = payments.length
    ? `<ul class="rows">${payments.slice(0, 6).map((p) => `
        <li class="row">
          <div class="grow">
            <strong>${esc(p.memberName)}</strong>
            <div class="muted small">${esc(p.note)} · ${esc(p.date)}</div>
          </div>
          <strong style="color:var(--green)">${money(p.amount)}</strong>
        </li>`).join("")}</ul>`
    : empty("No payments recorded yet.");

  $("#ops").innerHTML = `
    <ul class="rows">
      <li class="row"><div class="grow">Total check-ins</div><strong>${stats.totalCheckIns}</strong></li>
      <li class="row"><div class="grow">Expired memberships</div><strong>${stats.expiredMembers}</strong></li>
      <li class="row"><div class="grow">Trainers on staff</div><strong>${stats.totalTrainers}</strong></li>
      <li class="row"><div class="grow">Monthly trainer payroll</div><strong>${money(stats.totalSalaries)}</strong></li>
    </ul>`;
}

// ---------- Members ----------

function memberRow(m) {
  const left = m.active ? `${m.daysLeft} day${m.daysLeft === 1 ? "" : "s"} left` : "Expired";
  return `
    <tr>
      <td>
        <div class="person">
          <div class="avatar">${esc(initials(m.name))}</div>
          <div>
            <strong>${esc(m.name)}</strong>
            <div class="muted small">${esc(m.email)}</div>
          </div>
        </div>
      </td>
      <td>${esc(m.phone)}</td>
      <td><span class="chip plan-chip p${m.planId}">${esc(m.plan)}</span></td>
      <td>${esc(m.expiryDate)}<div class="muted small">${left}</div></td>
      <td>${statusBadge(m)}</td>
      <td class="num">${m.checkIns}</td>
      <td class="actions">
        <button class="btn sm ghost" data-action="checkin" data-id="${m.id}">Check in</button>
        <button class="btn sm" data-action="renew" data-id="${m.id}">Renew</button>
        <button class="btn sm ghost" data-action="plan" data-id="${m.id}">Change plan</button>
        <button class="btn sm soft-danger" data-action="delete" data-id="${m.id}">Delete</button>
      </td>
    </tr>`;
}

async function renderMembers() {
  app.members = await app.backend.members(app.memberSearch);
  paintMembers();
}

function paintMembers() {
  const counts = { all: app.members.length };
  ["active", "expiring", "expired"].forEach((f) => {
    counts[f] = app.members.filter((m) => matchesFilter(m, f)).length;
  });

  $$("#member-filter .seg").forEach((b) => {
    const key = b.dataset.filter;
    b.textContent = `${FILTER_LABELS[key]} (${counts[key]})`;
    b.classList.toggle("active", key === app.memberFilter);
  });

  const rows = app.members.filter((m) => matchesFilter(m, app.memberFilter));
  $("#members-body").innerHTML = rows.length
    ? rows.map(memberRow).join("")
    : `<tr><td colspan="7">${empty(app.memberSearch ? "No members match your search." : "No members in this view.")}</td></tr>`;
}

function openRenew(member) {
  const base = member.active ? dmyToISO(member.expiryDate) : todayISO();
  openForm({
    title: `Renew membership`,
    subtitle: `${member.name} · ${member.plan} plan`,
    submitLabel: "Renew and record payment",
    fields: [
      {
        name: "months",
        label: "Duration",
        type: "select",
        value: "1",
        options: monthOptions(),
        wide: true,
        onChange: (v) => {
          const n = Number(v);
          return `Charge ${money(member.fee * n)} · new expiry ${toDMY(addMonthsISO(base, n))}`;
        },
      },
    ],
    onSubmit: async (values) => {
      await app.backend.renewMember(member.id, Number(values.months));
      toast(`${member.name} renewed. Payment recorded.`);
      await reload();
    },
  });
}

function openChangePlan(member) {
  openForm({
    title: "Change membership plan",
    subtitle: `${member.name} · currently ${member.plan}`,
    submitLabel: "Update plan",
    fields: [
      {
        name: "plan",
        label: "New plan",
        type: "select",
        value: String(member.planId),
        options: planOptions(),
        wide: true,
        onChange: (v) => `Monthly fee becomes ${money(planById(v).fee)} from the next renewal`,
      },
    ],
    onSubmit: async (values) => {
      await app.backend.changePlan(member.id, Number(values.plan));
      toast("Plan updated.");
      await reload();
    },
  });
}

function openAddMember() {
  openForm({
    title: "Add new member",
    subtitle: "The first month's fee is recorded as a payment automatically.",
    submitLabel: "Add member",
    fields: [
      { name: "name", label: "Full name", required: true, placeholder: "e.g. Ravi Kumar", wide: true },
      { name: "phone", label: "Phone", required: true, placeholder: "9876543210" },
      { name: "email", label: "Email", type: "email", required: true, placeholder: "name@example.com" },
      {
        name: "plan",
        label: "Plan",
        type: "select",
        value: "2",
        options: planOptions(),
        wide: true,
        onChange: (v) => `First month: ${money(planById(v).fee)}`,
      },
    ],
    onSubmit: async (values) => {
      const member = await app.backend.addMember({
        name: values.name,
        phone: values.phone,
        email: values.email,
        plan: Number(values.plan),
      });
      toast(`${member.name} has joined. Joining fee recorded.`);
      await reload();
    },
  });
}

// ---------- Trainers ----------

async function renderTrainers() {
  app.trainers = await app.backend.trainers();
  const n = app.trainers.length;
  $("#trainer-count").textContent = `${n} trainer${n === 1 ? "" : "s"} on the team`;

  $("#trainer-grid").innerHTML = n
    ? app.trainers.map((t) => `
        <article class="card trainer">
          <div class="trainer-top">
            <div class="avatar lg">${esc(initials(t.name))}</div>
            <div>
              <h3>${esc(t.name)}</h3>
              <span class="chip">${esc(t.specialization)}</span>
            </div>
          </div>
          <dl class="meta">
            <div><dt>Phone</dt><dd>${esc(t.phone)}</dd></div>
            <div><dt>Email</dt><dd>${esc(t.email)}</dd></div>
            <div><dt>Monthly salary</dt><dd>${money(t.salary)}</dd></div>
          </dl>
          <div class="trainer-foot">
            <span class="muted small">ID #${t.id}</span>
            <button class="btn sm soft-danger" data-delete-trainer="${t.id}" data-name="${esc(t.name)}">Remove</button>
          </div>
        </article>`).join("")
    : `<div class="card" style="grid-column:1/-1">${empty("No trainers yet. Add your first trainer.")}</div>`;
}

function openAddTrainer() {
  openForm({
    title: "Add trainer",
    subtitle: "Trainers appear on the team page and in payroll totals.",
    submitLabel: "Add trainer",
    fields: [
      { name: "name", label: "Full name", required: true, placeholder: "e.g. Anita Rao", wide: true },
      { name: "phone", label: "Phone", required: true, placeholder: "9012345678" },
      { name: "email", label: "Email", type: "email", required: true, placeholder: "name@example.com" },
      { name: "specialization", label: "Specialization", required: true, placeholder: "Yoga, CrossFit...", wide: true },
      { name: "salary", label: "Monthly salary (₹)", type: "number", required: true, min: 0, step: 500, wide: true },
    ],
    onSubmit: async (values) => {
      const trainer = await app.backend.addTrainer({
        name: values.name,
        phone: values.phone,
        email: values.email,
        specialization: values.specialization,
        salary: Number(values.salary),
      });
      toast(`${trainer.name} added to the team.`);
      await reload();
    },
  });
}

// ---------- Payments ----------

async function renderPayments() {
  app.payments = await app.backend.payments();
  paintPayments();
}

function paintPayments() {
  const q = app.paymentSearch.trim().toLowerCase();
  const rows = app.payments.filter((p) => !q || p.memberName.toLowerCase().includes(q));
  const total = app.payments.reduce((sum, p) => sum + p.amount, 0);

  $("#pay-total").textContent = money(total);
  $("#pay-count").textContent = `${app.payments.length} transaction${app.payments.length === 1 ? "" : "s"}`;

  $("#payments-body").innerHTML = rows.length
    ? rows.map((p) => `
        <tr>
          <td>${esc(p.date)}</td>
          <td><strong>${esc(p.memberName)}</strong> <span class="muted small">#${p.memberId}</span></td>
          <td class="num"><strong>${money(p.amount)}</strong></td>
          <td class="muted">${esc(p.note)}</td>
        </tr>`).join("")
    : `<tr><td colspan="4">${empty(q ? "No payments match this name." : "No payments recorded yet.")}</td></tr>`;
}

// ---------- Plans ----------

async function renderPlans() {
  const members = await app.backend.members();
  $("#plans").innerHTML = app.plans.map((p) => {
    const count = members.filter((m) => m.planId === p.id && m.active).length;
    const popular = p.id === 2;
    return `
      <article class="card plan ${popular ? "popular" : ""}">
        ${popular ? `<span class="ribbon">Most popular</span>` : ""}
        <h3>${esc(p.name)}</h3>
        <div class="price">${money(p.fee)}<span> / month</span></div>
        <ul>${PLAN_FEATURES[p.id].map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
        <div class="plan-foot muted small">${count} active member${count === 1 ? "" : "s"} on this plan</div>
      </article>`;
  }).join("");
}

// ---------- Event wiring ----------

function bindEvents() {
  // Sidebar navigation and mobile menu
  $$(".nav-item").forEach((btn) => btn.addEventListener("click", () => go(btn.dataset.page)));
  $("#menu-btn").addEventListener("click", () => openSidebar(true));
  $("#scrim").addEventListener("click", () => openSidebar(false));

  // Generic buttons: data-goto="page" and data-open="add-member | add-trainer"
  const openers = { "add-member": openAddMember, "add-trainer": openAddTrainer };
  document.addEventListener("click", (e) => {
    const goTo = e.target.closest("[data-goto]");
    if (goTo) return go(goTo.dataset.goto);

    const open = e.target.closest("[data-open]");
    if (open) return openers[open.dataset.open]();
  });

  // Members: search, filters, row actions
  $("#member-search").addEventListener("input", debounce((e) => {
    app.memberSearch = e.target.value;
    renderMembers().catch(fail);
  }));

  $("#member-filter").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg");
    if (!btn) return;
    app.memberFilter = btn.dataset.filter;
    paintMembers();
  });

  $("#members-body").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;

    const id = Number(btn.dataset.id);
    const member = app.members.find((m) => m.id === id);
    if (!member) return;

    try {
      switch (btn.dataset.action) {
        case "checkin": {
          const result = await app.backend.checkIn(id);
          toast(result.message);
          await renderMembers();
          return;
        }
        case "renew":
          return openRenew(member);
        case "plan":
          return openChangePlan(member);
        case "delete": {
          const ok = await confirmDialog({
            title: `Delete ${member.name}?`,
            message: "The member is removed from the list. Their payment history is kept for accounting.",
            okLabel: "Delete member",
            danger: true,
          });
          if (!ok) return;
          await app.backend.deleteMember(id);
          toast("Member deleted.");
          await renderMembers();
          return;
        }
      }
    } catch (err) {
      fail(err);
    }
  });

  // Trainers: remove
  $("#trainer-grid").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-delete-trainer]");
    if (!btn) return;
    const ok = await confirmDialog({
      title: `Remove ${btn.dataset.name}?`,
      message: "This trainer will be removed from the team and from payroll totals.",
      okLabel: "Remove trainer",
      danger: true,
    });
    if (!ok) return;
    try {
      await app.backend.deleteTrainer(Number(btn.dataset.deleteTrainer));
      toast("Trainer removed.");
      await renderTrainers();
    } catch (err) {
      fail(err);
    }
  });

  // Payments: filter by name
  $("#payment-search").addEventListener("input", (e) => {
    app.paymentSearch = e.target.value;
    paintPayments();
  });

  // Dialog cancel
  $("#modal-cancel").addEventListener("click", () => $("#modal").close());

  // Demo data reset (browser mode only)
  $("#btn-reset").addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Reset demo data?",
      message: "All members, trainers and payments stored in this browser will be replaced with the sample data.",
      okLabel: "Reset",
      danger: true,
    });
    if (!ok) return;
    app.backend.reset();
    toast("Demo data has been reset.");
    reload();
  });
}

function paintMode() {
  const live = app.backend instanceof RemoteBackend;
  $("#mode-badge").innerHTML = live
    ? `<span class="dot green"></span><span>Live server connected</span>`
    : `<span class="dot amber"></span><span>Demo mode · data stays in this browser</span>`;
  $("#btn-reset").classList.toggle("hidden", live);
}

// ---------- Startup ----------

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();

  $("#today").textContent = new Date().toLocaleDateString("en-IN", {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  });

  app.backend = await detectBackend();
  paintMode();

  try {
    app.plans = await app.backend.plans();
  } catch (err) {
    fail(err);
  }

  const start = window.location.hash.slice(1);
  go(PAGES[start] ? start : "dashboard");
});
