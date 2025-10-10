import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

// -----------------------------------------------------
// Apps Script logging config (no dotenv needed)
// -----------------------------------------------------
const APPS_URL =
  process.env.APPS_SCRIPT_URL ||
  "https://script.google.com/macros/s/AKfycbwjPjBRySUQCYy0DY04_h-OzccjYaG09Tv0B13EfE-kQf1g7IEqja7ugrnuioFcxy2K/exec"; // <-- your /exec URL

const APPS_TOKEN =
  process.env.APPS_SHARED_SECRET ||
  "pWQF0tQ2q0eQ2qXQnQ1cW5qR7H0m8YbD"; // <-- must match SHARED_SECRET in Apps Script

async function appsPost(action, payload) {
  if (!APPS_URL || APPS_URL.includes("XXXXX")) {
    console.warn("[AppsScript] Skipping post: APPS_URL not set");
    return;
  }
  try {
    const body = { token: APPS_TOKEN, action, ...payload };
    const res = await fetch(APPS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      console.warn(`[AppsScript] ${action} -> HTTP ${res.status}: ${text}`);
    } else {
      console.log(`[AppsScript] ${action} -> ${text}`);
    }
  } catch (e) {
    console.warn("[AppsScript] post failed:", e);
  }
}

// Paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// App
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use("/", express.static(path.join(__dirname, "../client")));

// Steps (keys align with ?dept= in dashboard)
const steps = [
  { key: "registration",       label: "Registration",       dept: "Enrolment Officer",    prefix: "A" },
  { key: "marketing",          label: "Marketing",          dept: "Marketing Department", prefix: "A" },
  { key: "class_registration", label: "Class Registration", dept: "Timetable",            prefix: "A" },
  { key: "tuition_payment",    label: "Tuition Payment",    dept: "Fees",                 prefix: "A" },
  { key: "student_id",         label: "Student ID",         dept: "Library",              prefix: "A" }
];

// Ticket generator: A1..A100 → B1..B100 → … → Z100 → A1 loop
const makeTicketId = (() => {
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let prefixIndex = 0; // 'A'
  let number = 1;      // 1..100
  return (_ignored = "A") => {
    const t = `${LETTERS[prefixIndex]}${number}`;
    number += 1;
    if (number > 100) {
      number = 1;
      prefixIndex = (prefixIndex + 1) % LETTERS.length;
    }
    return t;
  };
})();

// In-memory state
const students = new Map();                      // ticket -> student
const queues = new Map(steps.map(s => [s.key, []]));
const currentServing = new Map(steps.map(s => [s.key, null]));

// Audit log (in-memory)
const auditLogs = []; // [{ ts, event, stepKey, ticket, staff, note, meta }]

// Helpers
const stepIndexByKey = new Map(steps.map((s, i) => [s.key, i]));
const nextStepKey = (key) => {
  const i = stepIndexByKey.get(key);
  return i == null ? null : (steps[i + 1]?.key ?? null);
};

function logEvent(entry) {
  auditLogs.push({
    ts: new Date().toISOString(),
    event: entry.event,
    stepKey: entry.stepKey || null,
    ticket: entry.ticket || null,
    staff: entry.staff || null,
    note: entry.note || null,
    meta: entry.meta ?? null,
  });
}

const publicState = () => ({
  steps,
  queues: Object.fromEntries([...queues.entries()]),
  currentServing: Object.fromEntries([...currentServing.entries()]),
});

const emitState = () => io.emit("state:update", publicState());
const emitStudent = (ticket) => {
  const student = students.get(ticket);
  if (student) io.emit("student:update", student);
};

// ================= API =================

// 1) Student check-in (Campus arrival)
app.post("/api/checkin", async (req, res) => {
  const { name, studentId, program, email, staff } = req.body || {};
  if (!name || !program) return res.status(400).json({ error: "name and program are required" });

  const reg = steps[0];
  const ticket = makeTicketId(reg.prefix);

  const student = {
    ticket,
    name,
    studentId: studentId || null,
    program,
    email: email || null,
    stepKey: reg.key,
    status: "queued", // queued | serving | complete
    history: [],
    notes: [],
    createdAt: new Date().toISOString(),
  };

  students.set(ticket, student);
  queues.get(reg.key).push(ticket);
  student.history.push({ stepKey: reg.key, action: "checkin", ts: new Date().toISOString(), staff: staff || null });
  logEvent({ event: "checkin", stepKey: reg.key, ticket, staff: staff || null, meta: { name, program } });

  // Apps Script: campus arrival
  await appsPost("checkin", {
    ticket,
    name,
    program,
    email: email || "",
    ts: new Date().toISOString(),
  });

  emitState();
  emitStudent(ticket);
  res.json({ ticket, stepKey: reg.key, steps });
});

// 2) Start next (Department IN)
app.post("/api/department/:step/start-next", async (req, res) => {
  const stepKey = req.params.step;
  const { staff } = req.body || {};

  if (!queues.has(stepKey)) return res.status(404).json({ error: "Unknown step" });
  if (currentServing.get(stepKey)) {
    return res.status(409).json({ error: "Already serving a student", ticket: currentServing.get(stepKey) });
  }

  const q = queues.get(stepKey);
  const ticket = q.shift() || null;
  if (!ticket) {
    currentServing.set(stepKey, null);
    emitState();
    return res.json({ ticket: null });
  }

  currentServing.set(stepKey, ticket);
  const student = students.get(ticket);
  const ts = new Date().toISOString();
  if (student) {
    student.status = "serving";
    student.stepKey = stepKey;
    student.history.push({ stepKey, action: "start", ts, staff: staff || null });
    logEvent({ event: "start", stepKey, ticket, staff: staff || null });

    // Apps Script: dept IN
    await appsPost("dept_in", { ticket, stepKey, ts });
  }

  emitState();
  emitStudent(ticket);
  res.json({ ticket });
});

// 3) Complete (Department OUT)
app.post("/api/department/:step/complete", async (req, res) => {
  const stepKey = req.params.step;
  const { staff, note } = req.body || {};
  const serving = currentServing.get(stepKey);
  if (!serving) return res.status(409).json({ error: "No student currently serving" });

  const student = students.get(serving);
  if (!student) return res.status(404).json({ error: "Student not found" });

  const ts = new Date().toISOString();
  student.history.push({
    stepKey,
    action: "complete",
    ts,
    staff: staff || null,
    note: note?.trim() ? note.trim() : null,
  });
  if (note && note.trim()) {
    student.notes.push({ stepKey, text: note.trim(), staff: staff || null, ts });
  }
  logEvent({
    event: "complete",
    stepKey,
    ticket: serving,
    staff: staff || null,
    note: note?.trim() || null,
    meta: { next: nextStepKey(stepKey) },
  });

  // Apps Script: dept OUT
  await appsPost("dept_out", { ticket: serving, stepKey, ts });

  // Move to next or finish
  currentServing.set(stepKey, null);
  const nextKey = nextStepKey(stepKey);
  if (nextKey) {
    student.stepKey = nextKey;
    student.status = "queued";
    queues.get(nextKey).push(serving);
  } else {
    student.status = "complete";
  }

  emitState();
  emitStudent(serving);
  res.json({ ok: true, nextStep: nextKey || null });
});

// 4) HOLD → re-queue to end (no sheet change)
app.post("/api/department/:step/hold", async (req, res) => {
  const stepKey = req.params.step;
  const { staff, ticket: requestedTicket, reason } = req.body || {};
  if (!queues.has(stepKey)) return res.status(404).json({ error: "Unknown step" });

  const q = queues.get(stepKey);

  let target = requestedTicket || currentServing.get(stepKey);
  if (!target) return res.status(409).json({ error: "No student currently serving and no ticket specified" });

  if (currentServing.get(stepKey) === target) {
    currentServing.set(stepKey, null);
  }
  const i = q.indexOf(target);
  if (i >= 0) q.splice(i, 1);
  q.push(target);

  const student = students.get(target);
  const ts = new Date().toISOString();
  if (student) {
    student.status = "queued";
    student.stepKey = stepKey;
    student.history.push({
      stepKey,
      action: "hold_requeue",
      ts,
      staff: staff || null,
      note: reason || null,
    });
  }
  logEvent({
    event: "hold_requeue",
    stepKey,
    ticket: target,
    staff: staff || null,
    note: reason || null,
    meta: { reason: reason || undefined },
  });

  emitState();
  if (student) emitStudent(target);
  res.json({ ok: true, ticket: target, queuedAtEnd: true });
});

// 5) Skip → re-queue to end + mark dept OUT
app.post("/api/department/:step/skip", async (req, res) => {
  const stepKey = req.params.step;
  const { staff } = req.body || {};
  const serving = currentServing.get(stepKey);
  if (!serving) return res.status(409).json({ error: "No student currently serving" });

  currentServing.set(stepKey, null);
  queues.get(stepKey).push(serving);

  const student = students.get(serving);
  const ts = new Date().toISOString();
  if (student) {
    student.status = "queued";
    student.history.push({ stepKey, action: "skip", ts, staff: staff || null });
    logEvent({ event: "skip", stepKey, ticket: serving, staff: staff || null });
  }

  // Apps Script: treat skip as dept OUT
  await appsPost("dept_out", { ticket: serving, stepKey, ts });

  emitState();
  emitStudent(serving);
  res.json({ ok: true });
});

// 6) Notes
app.post("/api/department/:step/note", (req, res) => {
  const stepKey = req.params.step;
  const { text, staff, ticket } = req.body || {};
  const t = ticket || currentServing.get(stepKey);

  if (!text || !text.trim()) return res.status(400).json({ error: "note text required" });
  if (!t) return res.status(409).json({ error: "No ticket specified and none currently serving" });

  const student = students.get(t);
  if (!student) return res.status(404).json({ error: "Ticket not found" });

  const noteEntry = {
    stepKey,
    text: String(text).trim(),
    staff: staff || null,
    ts: new Date().toISOString(),
  };
  student.notes.push(noteEntry);
  logEvent({ event: "note_add", stepKey, ticket: t, staff: staff || null, note: noteEntry.text });

  emitStudent(t);
  res.json({ ok: true, note: noteEntry });
});

// Read-only helpers
app.get("/api/status", (req, res) => res.json(publicState()));
app.get("/api/student/:ticket", (req, res) => {
  const student = students.get(req.params.ticket);
  if (!student) return res.status(404).json({ error: "Not found" });
  res.json(student);
});
app.get("/api/department/:step/serving", (req, res) => {
  const stepKey = req.params.step;
  const t = currentServing.get(stepKey);
  const student = t ? students.get(t) : null;
  res.json({ ticket: t || null, student });
});

// Logs export (raw)
app.get("/api/logs", (req, res) => res.json({ logs: auditLogs }));
app.get("/api/logs.csv", (req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"queue-logs.csv\"");
  const header = ["ts", "event", "stepKey", "ticket", "staff", "note", "meta"];
  const esc = (v) => {
    if (v == null) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const rows = auditLogs.map(r =>
    [r.ts, r.event, r.stepKey, r.ticket, r.staff, r.note, r.meta ? JSON.stringify(r.meta) : ""]
      .map(esc)
      .join(",")
  );
  res.send([header.join(","), ...rows].join("\n"));
});

// Sockets
io.on("connection", (socket) => {
  socket.emit("state:update", publicState());
});

// Start with fallback if port is busy
const DEFAULT_PORT = Number(process.env.PORT) || 3000;

function printUrls(actualPort) {
  console.log(`Enrolment queue running on http://localhost:${actualPort}`);
  console.log("Open the UI:");
  console.log(`  Student Check-in:     http://localhost:${actualPort}/index.html`);
  console.log(`  Public Display:       http://localhost:${actualPort}/display.html`);
  console.log(`  Department Dashboard: http://localhost:${actualPort}/dashboard.html?dept=registration`);
}

function start(port) {
  server.listen(port, () => {
    const actual = server.address().port;
    printUrls(actual);
  });
}

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.warn(`Port ${DEFAULT_PORT} is in use. Trying a free port...`);
    start(0);
  } else {
    throw err;
  }
});

start(DEFAULT_PORT);
