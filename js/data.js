"use strict";

/* =========================================================================
   FitCore data layer

   Two interchangeable backends with the same async methods:

     stats()              plans()              payments()
     members(search?)     addMember(data)      renewMember(id, months)
     checkIn(id)          changePlan(id, plan) deleteMember(id)
     trainers()           addTrainer(data)     deleteTrainer(id)

   RemoteBackend  Calls the C++ server's REST API (/api/...). Used when the
                  site is served by gym_server, i.e. "make run" on your computer.

   LocalBackend   Runs the same business rules in the browser, storing data in
                  localStorage. Used when no server is reachable, e.g. on
                  GitHub Pages. The rules and messages mirror backend/src/*.cpp.
   ========================================================================= */

const PLAN_CATALOG = [
  { id: 1, name: "Basic", fee: 1000 },
  { id: 2, name: "Standard", fee: 1500 },
  { id: 3, name: "Premium", fee: 2500 },
];

const STORE_KEY = "fitcore-gym-v1";
const DAY_MS = 86400000;

// ---------- Date helpers (dates are stored as yyyy-mm-dd in the browser) ----------

const pad2 = (n) => String(n).padStart(2, "0");
const isoOf = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;   // m is 1-based

function todayISO() {
  const d = new Date();
  return isoOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function utcOf(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function addMonthsISO(iso, months) {
  const [y, m, d] = iso.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const newYear = Math.floor(total / 12);
  const newMonth = total % 12;                       // 0-based
  const lastDay = new Date(Date.UTC(newYear, newMonth + 1, 0)).getUTCDate();
  return isoOf(newYear, newMonth + 1, Math.min(d, lastDay));
}

// "2026-11-14" -> "14-11-2026" (the format the C++ server uses)
function toDMY(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

// "14-11-2026" -> "2026-11-14"
function dmyToISO(dmy) {
  const [d, m, y] = dmy.split("-").map(Number);
  return isoOf(y, m, d);
}

// ---------- Validation (same rules as backend/src/Api.cpp) ----------

const isText = (s, max) => s.length > 0 && s.length <= max && !/[|\r\n]/.test(s);
const isPhone = (s) => /^[0-9+\- ]{7,15}$/.test(s);
const isEmail = (s) => {
  const at = s.indexOf("@");
  return at > 0 && s.indexOf(".", at) !== -1 && s[s.length - 1] !== "." &&
         s.length <= 100 && !/[ |\r\n]/.test(s);
};
const planById = (id) => PLAN_CATALOG.find((p) => p.id === Number(id));

function checkMember(d) {
  if (!isText(d.name, 80)) return "Name is required (max 80 characters, no '|')";
  if (!isPhone(d.phone)) return "Phone must be 7-15 digits (may include + - and spaces)";
  if (!isEmail(d.email)) return "A valid email address is required";
  if (!planById(d.plan)) return "Plan must be 1 (Basic), 2 (Standard) or 3 (Premium)";
  return null;
}

function checkTrainer(d) {
  if (!isText(d.name, 80)) return "Name is required (max 80 characters, no '|')";
  if (!isPhone(d.phone)) return "Phone must be 7-15 digits (may include + - and spaces)";
  if (!isEmail(d.email)) return "A valid email address is required";
  if (!isText(d.specialization, 60)) return "Specialization is required (max 60 characters, no '|')";
  if (!(d.salary >= 0 && d.salary <= 10000000)) return "Salary must be between 0 and 1,00,00,000";
  return null;
}

// ==========================================================================
//  RemoteBackend: talks to the C++ server
// ==========================================================================

class RemoteBackend {
  async request(method, path, body) {
    const options = { method, headers: {} };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(`api${path}`, options);
    } catch (_) {
      throw new Error("Cannot reach the server. Is gym_server still running?");
    }

    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  stats() { return this.request("GET", "/stats"); }
  plans() { return this.request("GET", "/plans"); }
  payments() { return this.request("GET", "/payments"); }
  members(search = "") {
    return this.request("GET", `/members${search ? `?search=${encodeURIComponent(search)}` : ""}`);
  }
  addMember(data) { return this.request("POST", "/members", data); }
  renewMember(id, months) { return this.request("POST", `/members/${id}/renew`, { months }); }
  checkIn(id) { return this.request("POST", `/members/${id}/checkin`); }
  changePlan(id, plan) { return this.request("PUT", `/members/${id}/plan`, { plan }); }
  deleteMember(id) { return this.request("DELETE", `/members/${id}`); }
  trainers() { return this.request("GET", "/trainers"); }
  addTrainer(data) { return this.request("POST", "/trainers", data); }
  deleteTrainer(id) { return this.request("DELETE", `/trainers/${id}`); }
}

// ==========================================================================
//  LocalBackend: same rules, stored in the browser
// ==========================================================================

class LocalBackend {
  constructor() {
    this.db = this.read() || this.seed();
    this.write();
  }

  // ----- storage -----
  read() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  write() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.db));
    } catch (_) {
      /* storage full or disabled: keep working in memory */
    }
  }

  reset() {
    this.db = this.seed();
    this.write();
  }

  seed() {
    this.db = { nextMemberId: 1, nextTrainerId: 1, nextPaymentId: 1, members: [], trainers: [], payments: [] };
    this.insertMember({ name: "Rahul Sharma", phone: "9876543210", email: "rahul@example.com", plan: 2 });
    this.insertMember({ name: "Priya Verma", phone: "9123456780", email: "priya@example.com", plan: 3 });
    this.insertMember({ name: "Amit Singh", phone: "9988776655", email: "amit@example.com", plan: 1 });
    this.insertTrainer({ name: "Anita Rao", phone: "9012345678", email: "anita@example.com", specialization: "Yoga", salary: 30000 });
    this.insertTrainer({ name: "Vikram Joshi", phone: "9090909090", email: "vikram@example.com", specialization: "Strength & Conditioning", salary: 35000 });
    return this.db;
  }

  // ----- internal helpers -----
  insertMember({ name, phone, email, plan }) {
    const start = todayISO();
    const member = {
      id: this.db.nextMemberId++,
      name, phone, email,
      planId: Number(plan),
      startDate: start,
      expiryDate: addMonthsISO(start, 1),
      checkIns: 0,
    };
    this.db.members.push(member);
    this.recordPayment(member, planById(plan).fee, `New membership (${planById(plan).name}, 1 month)`);
    return member;
  }

  insertTrainer({ name, phone, email, specialization, salary }) {
    const trainer = { id: this.db.nextTrainerId++, name, phone, email, specialization, salary: Number(salary) };
    this.db.trainers.push(trainer);
    return trainer;
  }

  recordPayment(member, amount, note) {
    this.db.payments.push({
      id: this.db.nextPaymentId++,
      memberId: member.id,
      memberName: member.name,
      amount,
      date: toDMY(todayISO()),
      note,
    });
  }

  findMember(id) {
    const member = this.db.members.find((m) => m.id === Number(id));
    if (!member) throw new Error("Member not found");
    return member;
  }

  memberView(m) {
    const daysLeft = Math.round((utcOf(m.expiryDate) - utcOf(todayISO())) / DAY_MS);
    const plan = planById(m.planId);
    return {
      id: m.id,
      name: m.name,
      phone: m.phone,
      email: m.email,
      plan: plan.name,
      planId: plan.id,
      fee: plan.fee,
      startDate: toDMY(m.startDate),
      expiryDate: toDMY(m.expiryDate),
      daysLeft,
      checkIns: m.checkIns,
      active: daysLeft >= 0,
    };
  }

  trainerView(t) {
    return { ...t };
  }

  // ----- public API (async to match RemoteBackend) -----
  async stats() {
    const members = this.db.members.map((m) => this.memberView(m));
    const active = members.filter((m) => m.active);
    const count = (id) => members.filter((m) => m.planId === id).length;
    return {
      totalMembers: members.length,
      activeMembers: active.length,
      expiredMembers: members.length - active.length,
      expiringSoon: active.filter((m) => m.daysLeft <= 7).length,
      basicCount: count(1),
      standardCount: count(2),
      premiumCount: count(3),
      totalCheckIns: members.reduce((s, m) => s + m.checkIns, 0),
      totalTrainers: this.db.trainers.length,
      expectedMonthlyRevenue: active.reduce((s, m) => s + m.fee, 0),
      totalCollected: this.db.payments.reduce((s, p) => s + p.amount, 0),
      totalSalaries: this.db.trainers.reduce((s, t) => s + t.salary, 0),
    };
  }

  async plans() {
    return PLAN_CATALOG.map((p) => ({ ...p }));
  }

  async payments() {
    return this.db.payments.slice().reverse().map((p) => ({ ...p }));   // newest first
  }

  async members(search = "") {
    const q = search.trim().toLowerCase();
    return this.db.members
      .filter((m) => !q || m.name.toLowerCase().includes(q) || m.phone.includes(q))
      .map((m) => this.memberView(m));
  }

  async addMember(data) {
    const error = checkMember(data);
    if (error) throw new Error(error);
    return this.memberView(this.insertMember(data));
  }

  async renewMember(id, months) {
    const count = Number(months);
    if (!Number.isInteger(count) || count < 1 || count > 12) {
      throw new Error("Months must be a whole number from 1 to 12");
    }
    const member = this.findMember(id);
    const view = this.memberView(member);
    const base = view.active ? member.expiryDate : todayISO();
    member.expiryDate = addMonthsISO(base, count);
    this.recordPayment(member, planById(member.planId).fee * count, `Renewal for ${count} month(s)`);
    this.write();
    return this.memberView(member);
  }

  async checkIn(id) {
    const member = this.findMember(id);
    if (!this.memberView(member).active) {
      throw new Error("Membership has expired. Renew before checking in.");
    }
    member.checkIns++;
    this.write();
    return { message: `Check-in recorded for ${member.name}`, checkIns: member.checkIns };
  }

  async changePlan(id, plan) {
    if (!planById(plan)) throw new Error("Plan must be 1 (Basic), 2 (Standard) or 3 (Premium)");
    const member = this.findMember(id);
    member.planId = Number(plan);
    this.write();
    return this.memberView(member);
  }

  async deleteMember(id) {
    const index = this.db.members.findIndex((m) => m.id === Number(id));
    if (index === -1) throw new Error("Member not found");
    this.db.members.splice(index, 1);
    this.write();
    return { message: "Member deleted" };
  }

  async trainers() {
    return this.db.trainers.map((t) => this.trainerView(t));
  }

  async addTrainer(data) {
    const error = checkTrainer(data);
    if (error) throw new Error(error);
    const trainer = this.insertTrainer(data);
    this.write();
    return this.trainerView(trainer);
  }

  async deleteTrainer(id) {
    const index = this.db.trainers.findIndex((t) => t.id === Number(id));
    if (index === -1) throw new Error("Trainer not found");
    this.db.trainers.splice(index, 1);
    this.write();
    return { message: "Trainer deleted" };
  }
}

// ==========================================================================
//  Picks the backend: the C++ server if it answers, otherwise browser mode
// ==========================================================================

async function detectBackend() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch("api/stats", { cache: "no-store", signal: controller.signal });
    const type = res.headers.get("content-type") || "";
    if (res.ok && type.includes("application/json")) return new RemoteBackend();
  } catch (_) {
    /* no server here: fall through to browser mode */
  } finally {
    clearTimeout(timer);
  }
  return new LocalBackend();
}
