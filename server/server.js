import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

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

// Steps
const steps = [
  { key: "registration",       label: "Registration",       dept: "Enrolment Officer",   prefix: "A" },
  { key: "marketing",          label: "Marketing",          dept: "Marketing Department", prefix: "A" },
  { key: "class_registration", label: "Class Registration", dept: "Timetable",            prefix: "A" },
  { key: "tuition_payment",    label: "Tuition Payment",    dept: "Fees",                 prefix: "A" },
  { key: "student_id",         label: "Student ID",         dept: "Library",              prefix: "A" }
];

// Ticket generator (swap for DB sequence later)
const makeTicketId = (() => {
  let seq = 1000;
  return (prefix = "A") => `${prefix}${++seq}`;
})();

// In-memory state
const students = new Map(); // ticket -> student
const queues = new Map(steps.map(s => [s.key, []]));
const currentServing = new Map(steps.map(s => [s.key, null]));
const holds = new Map(steps.map(s => [s.key, new Set()]));

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
  holdsCount: Object.fromEntries([...holds.entries()].map(([k, set]) => [k, set.size])),
});

const emitState = () => io.emit("state:update", publicState());
const emitStudent = (ticket) => {
  const student = students.get(ticket);
  if (student) io.emit("student:update", student);
};

// API

// 1) Student check-in (Step 1 issues ticket)
app.post("/api/checkin", (req, res) => {
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
    status: "queued", // queued | serving | hold | complete
    history: [],
    notes: [], // per-ticket notes across steps
    createdAt: new Date().toISOString(),
  };

  students.set(ticket, student);
  queues.get(reg.key).push(ticket);
  student.history.push({ stepKey: reg.key, action: "checkin", ts: new Date().toISOString(), staff: staff || null });
  logEvent({ event: "checkin", stepKey: reg.key, ticket, staff: staff || null, meta: { name, program } });

  emitState();
  emitStudent(ticket);
  res.json({ ticket, stepKey: reg.key, steps });
});

// 2) Department actions

// Pull next if idle
app.post("/api/department/:step/start-next", (req, res) => {
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
  if (student) {
    student.status = "serving";
    student.stepKey = stepKey;
    student.history.push({ stepKey, action: "start", ts: new Date().toISOString(), staff: staff || null });
    logEvent({ event: "start", stepKey, ticket, staff: staff || null });
  }

  emitState();
  emitStudent(ticket);
  res.json({ ticket });
});

// Complete current -> move to next or finish (with optional note logged)
app.post("/api/department/:step/complete", (req, res) => {
  const stepKey = req.params.step;
  const { staff, note } = req.body || {};  // optional note
  const serving = currentServing.get(stepKey);
  if (!serving) return res.status(409).json({ error: "No student currently serving" });

  const student = students.get(serving);
  if (!student) return res.status(404).json({ error: "Student not found" });

  // History entry (keep note if provided)
  student.history.push({
    stepKey,
    action: "complete",
    ts: new Date().toISOString(),
    staff: staff || null,
    note: note?.trim() ? note.trim() : null,
  });

  // If note provided, also add to notes for this step
  if (note && note.trim()) {
    student.notes.push({
      stepKey,
      text: note.trim(),
      staff: staff || null,
      ts: new Date().toISOString(),
    });
  }

  // Log completion (note included if provided)
  logEvent({
    event: "complete",
    stepKey,
    ticket: serving,
    staff: staff || null,
    note: note?.trim() ? note.trim() : null,
    meta: { next: nextStepKey(stepKey) },
  });

  // Clear serving and move on
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

// Put current on hold
app.post("/api/department/:step/hold", (req, res) => {
  const stepKey = req.params.step;
  const { staff } = req.body || {};
  const serving = currentServing.get(stepKey);
  if (!serving) return res.status(409).json({ error: "No student currently serving" });

  currentServing.set(stepKey, null);
  const student = students.get(serving);
  if (student) {
    student.status = "hold";
    student.history.push({ stepKey, action: "hold", ts: new Date().toISOString(), staff: staff || null });
    holds.get(stepKey).add(serving);
    logEvent({ event: "hold", stepKey, ticket: serving, staff: staff || null });
  }

  emitState();
  emitStudent(serving);
  res.json({ ok: true });
});

// Return a held ticket to the queue
app.post("/api/department/:step/return/:ticket", (req, res) => {
  const stepKey = req.params.step;
  const { staff } = req.body || {};
  const { ticket } = req.params;
  if (!holds.get(stepKey).has(ticket)) {
    return res.status(404).json({ error: "Ticket not on hold at this step" });
  }
  holds.get(stepKey).delete(ticket);
  queues.get(stepKey).push(ticket);

  const student = students.get(ticket);
  if (student) {
    student.status = "queued";
    student.history.push({ stepKey, action: "return", ts: new Date().toISOString(), staff: staff || null });
    logEvent({ event: "return", stepKey, ticket, staff: staff || null });
  }

  emitState();
  emitStudent(ticket);
  res.json({ ok: true });
});

// Skip current -> send to end of queue
app.post("/api/department/:step/skip", (req, res) => {
  const stepKey = req.params.step;
  const { staff } = req.body || {};
  const serving = currentServing.get(stepKey);
  if (!serving) return res.status(409).json({ error: "No student currently serving" });

  currentServing.set(stepKey, null);
  queues.get(stepKey).push(serving);

  const student = students.get(serving);
  if (student) {
    student.status = "queued";
    student.history.push({ stepKey, action: "skip", ts: new Date().toISOString(), staff: staff || null });
    logEvent({ event: "skip", stepKey, ticket: serving, staff: staff || null });
  }

  emitState();
  emitStudent(serving);
  res.json({ ok: true });
});

// Notes: add a note for current serving (or specify ticket)
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

// Read-only
app.get("/api/status", (req, res) => {
  res.json(publicState());
});

app.get("/api/student/:ticket", (req, res) => {
  const student = students.get(req.params.ticket);
  if (!student) return res.status(404).json({ error: "Not found" });
  res.json(student);
});

app.get("/api/department/:step/holds", (req, res) => {
  const stepKey = req.params.step;
  if (!holds.has(stepKey)) return res.status(404).json({ error: "Unknown step" });
  const items = Array.from(holds.get(stepKey).values());
  res.json({ stepKey, tickets: items, count: items.length });
});

app.get("/api/department/:step/serving", (req, res) => {
  const stepKey = req.params.step;
  const t = currentServing.get(stepKey);
  const student = t ? students.get(t) : null;
  res.json({ ticket: t || null, student });
});

// Logs export
app.get("/api/logs", (req, res) => {
  res.json({ logs: auditLogs });
});

app.get("/api/logs.csv", (req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"queue-logs.csv\"");
  const header = ["ts", "event", "stepKey", "ticket", "staff", "note", "meta"];
  const esc = (v) => {
    if (v == null) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const rows = auditLogs.map(r => [
    r.ts, r.event, r.stepKey, r.ticket, r.staff, r.note, r.meta ? JSON.stringify(r.meta) : "",
  ].map(esc).join(","));
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
  console.log(`  Student Progress:     http://localhost:${actualPort}/progress.html?ticket=A1001`);
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
