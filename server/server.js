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

// Steps (order matters)
const steps = [
  { key: "registration",       label: "Registration",       dept: "Enrolment Officer",   prefix: "A", page: "registration.html" },
  { key: "marketing",          label: "Marketing",          dept: "Marketing Office",    prefix: "A", page: "marketing.html" },
  { key: "class_registration", label: "Student Portal & Timetable", dept: "Academic",     prefix: "A", page: "timetable.html" },
  { key: "tuition_payment",    label: "Tuition Payment",    dept: "Fees",                 prefix: "A", page: "fees.html" },
  { key: "student_id",         label: "Student ID Card",    dept: "Library",              prefix: "A", page: "idcard.html" }
];

// Simple ticket generator (swap for DB later)
const makeTicketId = (() => { let seq = 1000; return (p="A") => `${p}${++seq}`; })();

// In-memory state
const students = new Map();                           // ticket -> student
const queues = new Map(steps.map(s => [s.key, []]));  // per-step queues
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
const stepPageByKey = Object.fromEntries(steps.map(s => [s.key, s.page]));

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
const emitState   = () => io.emit("state:update", publicState());
const emitStudent = (ticket) => { const s = students.get(ticket); if (s) io.emit("student:update", s); };

// ---------- Form schemas per step (based on your card) ----------
const FORM_SCHEMAS = {
  registration: (d) => ({
    studentId:       nullishToNull(d.studentId),
    fullName:        nullishToNull(d.fullName),
    dob:             nullishToNull(d.dob),              // YYYY-MM-DD
    courseName:      nullishToNull(d.courseName),
    intakeDate:      nullishToNull(d.intakeDate),       // YYYY-MM-DD
    campus:          oneOf(d.campus, ["Sydney","Newcastle"]),
    usi:             nullishToNull(d.usi),
    usiRegistered:   !!d.usiRegistered,
    emailCreated:    !!d.emailCreated,
    detailsVerified: !!d.detailsVerified,
    detailsDone:     !!d.detailsDone,
  }),
  marketing: (d) => ({
    marketingOfficer:   nullishToNull(d.marketingOfficer),  // Aarati, Shannen, Jenny, Jack, Asya, other
    admissionsOfficer:  nullishToNull(d.admissionsOfficer), // Sam, Lorenzo, David, Other
    agentSurvey:        !!d.agentSurvey,
    studyModeF2F:       !!d.studyModeF2F,
    documentCertified:  !!d.documentCertified,
    conditionalCOE:     !!d.conditionalCOE,
    scholarships:       !!d.scholarships,
    ects:               !!d.ects,
    versantInterview:   !!d.versantInterview,
    comments:           nullishToNull(d.comments),
  }),
  class_registration: (d) => ({
    academicOfficer:    nullishToNull(d.academicOfficer),  // Effendy, Towhid, Sarah, Emma, Kamuta, Sagar, Other
    ls100FromWk4:       !!d.ls100FromWk4,
    portalTraining:     !!d.portalTraining,
    timetableRegistered:!!d.timetableRegistered,
    comments:           nullishToNull(d.comments),
  }),
  tuition_payment: (d) => ({
    financeOfficer:     nullishToNull(d.financeOfficer),   // Yerin, Maria, Nana, Jennifer, Michael, Jenna, Carol, Other
    paidFull:           !!d.paidFull,
    outstandingAmount:  numberOrNull(d.outstandingAmount),
    comments:           nullishToNull(d.comments),
  }),
  student_id: (d) => ({
    libraryOfficer:     nullishToNull(d.libraryOfficer),   // Lakshmi, Caitlin, Peter, Other
    photoTaken:         !!d.photoTaken,
    idCardIssued:       !!d.idCardIssued,
    campus:             oneOf(d.campus, ["Sydney","Newcastle"]),
    comments:           nullishToNull(d.comments),
  }),
};
function nullishToNull(v){ return (v===undefined||v==="") ? null : String(v); }
function numberOrNull(v){ const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function oneOf(v, list){ if(v==null||v==="") return null; const s=String(v); return list.includes(s)?s:null; }

function snapshotStudent(student) {
  // Make a clean JSON snapshot
  return {
    ticket: student.ticket,
    name: student.name,
    studentId: student.studentId,
    program: student.program,
    email: student.email,
    dob: student.dob,
    usi: student.usi,
    stepKey: student.stepKey,
    status: student.status,
    forms: student.forms || {},
    createdAt: student.createdAt,
    history: student.history,  // this is fine to include; if you want less, omit
    notes: student.notes,
  };
}
// ---------------------------------------------------------------

// API

// Check-in (Step 1 creates ticket)
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
    dob: null,
    usi: null,
    stepKey: reg.key,
    status: "queued", // queued | serving | hold | complete
    history: [],
    notes: [],
    forms: {},
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

// Start next
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
  emitState(); emitStudent(ticket);
  res.json({ ticket });
});

// Save per-step form
app.post("/api/department/:step/form", (req, res) => {
  const stepKey = req.params.step;
  const { staff, data, ticket } = req.body || {};
  const t = ticket || currentServing.get(stepKey);
  if (!t) return res.status(409).json({ error: "No ticket specified and none currently serving" });
  const student = students.get(t);
  if (!student) return res.status(404).json({ error: "Ticket not found" });

  const schema = FORM_SCHEMAS[stepKey];
  if (!schema) return res.status(404).json({ error: "Unknown step" });

  // Sanitize/normalize
  const incoming = schema(data || {});
  if (!student.forms) student.forms = {};
  if (!student.forms[stepKey]) student.forms[stepKey] = {};
  student.forms[stepKey] = { ...student.forms[stepKey], ...incoming };

  // Sync top-level canonical fields where it makes sense (mainly Registration)
  if (stepKey === "registration") {
    if (incoming.studentId)   student.studentId = incoming.studentId;
    if (incoming.fullName)    student.name      = incoming.fullName;
    if (incoming.dob)         student.dob       = incoming.dob;
    if (incoming.courseName)  student.program   = incoming.courseName;
    if (incoming.usi)         student.usi       = incoming.usi;
    if (incoming.campus)      student.campus    = incoming.campus;
    if (incoming.intakeDate)  student.intakeDate= incoming.intakeDate;
  }

  student.history.push({ stepKey, action: "form_save", ts: new Date().toISOString(), staff: staff || null });
  logEvent({ event: "form_save", stepKey, ticket: t, staff: staff || null, meta: { keys: Object.keys(incoming) }});

  emitStudent(t);
  res.json({ ok: true, form: student.forms[stepKey] });
});

// Complete -> move forward; on last step log FINAL snapshot
app.post("/api/department/:step/complete", (req, res) => {
  const stepKey = req.params.step;
  const { staff, note } = req.body || {};
  const serving = currentServing.get(stepKey);
  if (!serving) return res.status(409).json({ error: "No student currently serving" });
  const student = students.get(serving);
  if (!student) return res.status(404).json({ error: "Student not found" });

  student.history.push({
    stepKey, action: "complete", ts: new Date().toISOString(),
    staff: staff || null, note: note?.trim() ? note.trim() : null,
  });
  if (note && note.trim()) {
    student.notes.push({ stepKey, text: note.trim(), staff: staff || null, ts: new Date().toISOString() });
  }

  const nxt = nextStepKey(stepKey);
  logEvent({ event: "complete", stepKey, ticket: serving, staff: staff || null, note: note?.trim() || null, meta: { next: nxt }});

  currentServing.set(stepKey, null);

  if (nxt) {
    student.stepKey = nxt;
    student.status = "queued";
    queues.get(nxt).push(serving);
  } else {
    // LAST STEP: mark complete and write FINAL snapshot to logs
    student.status = "complete";
    const snapshot = snapshotStudent(student);
    logEvent({ event: "finalize", stepKey, ticket: serving, staff: staff || null, meta: snapshot });
  }

  emitState(); emitStudent(serving);
  res.json({ ok: true, nextStep: nxt || null, nextPage: nxt ? stepPageByKey[nxt] : null });
});

// Hold
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
  emitState(); emitStudent(serving);
  res.json({ ok: true });
});

// Return from hold
app.post("/api/department/:step/return/:ticket", (req, res) => {
  const stepKey = req.params.step;
  const { staff } = req.body || {};
  const { ticket } = req.params;
  if (!holds.get(stepKey).has(ticket)) return res.status(404).json({ error: "Ticket not on hold at this step" });

  holds.get(stepKey).delete(ticket);
  queues.get(stepKey).push(ticket);
  const student = students.get(ticket);
  if (student) {
    student.status = "queued";
    student.history.push({ stepKey, action: "return", ts: new Date().toISOString(), staff: staff || null });
    logEvent({ event: "return", stepKey, ticket, staff: staff || null });
  }
  emitState(); emitStudent(ticket);
  res.json({ ok: true });
});

// Skip -> end of queue
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
  emitState(); emitStudent(serving);
  res.json({ ok: true });
});

// Notes
app.post("/api/department/:step/note", (req, res) => {
  const stepKey = req.params.step;
  const { text, staff, ticket } = req.body || {};
  const t = ticket || currentServing.get(stepKey);
  if (!text || !text.trim()) return res.status(400).json({ error: "note text required" });
  if (!t) return res.status(409).json({ error: "No ticket specified and none currently serving" });
  const student = students.get(t);
  if (!student) return res.status(404).json({ error: "Ticket not found" });

  const noteEntry = { stepKey, text: String(text).trim(), staff: staff || null, ts: new Date().toISOString() };
  student.notes.push(noteEntry);
  logEvent({ event: "note_add", stepKey, ticket: t, staff: staff || null, note: noteEntry.text });
  emitStudent(t);
  res.json({ ok: true, note: noteEntry });
});

// Read-only
app.get("/api/status", (req, res) => res.json(publicState()));
app.get("/api/student/:ticket", (req, res) => {
  const s = students.get(req.params.ticket);
  if (!s) return res.status(404).json({ error: "Not found" });
  res.json(s);
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
app.get("/api/logs", (req, res) => res.json({ logs: auditLogs }));
app.get("/api/logs.csv", (req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"queue-logs.csv\"");
  const header = ["ts","event","stepKey","ticket","staff","note","meta"];
  const esc = (v) => {
    if (v == null) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return `"${s.replace(/"/g,'""')}"`;
  };
  const rows = auditLogs.map(r => [r.ts, r.event, r.stepKey, r.ticket, r.staff, r.note, r.meta ? JSON.stringify(r.meta) : ""].map(esc).join(","));
  res.send([header.join(","), ...rows].join("\n"));
});

// Sockets
io.on("connection", (socket) => { socket.emit("state:update", publicState()); });

// Start with fallback if busy
const DEFAULT_PORT = Number(process.env.PORT) || 3000;
function start(p){ server.listen(p, () => { const a = server.address().port;
  console.log(`Enrolment queue on http://localhost:${a}`);
  console.log(`Registration:  /registration.html`);
  console.log(`Marketing:     /marketing.html`);
  console.log(`Timetable:     /timetable.html`);
  console.log(`Fees:          /fees.html`);
  console.log(`Student ID:    /idcard.html`);
});}
server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") { console.warn(`Port ${DEFAULT_PORT} busy. Trying free port...`); start(0); }
  else throw err;
});
start(DEFAULT_PORT);
