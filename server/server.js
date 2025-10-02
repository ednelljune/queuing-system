import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { customAlphabet } from "nanoid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: "*" },
});

app.use(cors());
app.use(express.json());

// Serve client
app.use("/", express.static(path.join(__dirname, "../client")));

const steps = [
  { key: "registration", label: "Registration", dept: "Enrolment Officer", prefix: "A" },
  { key: "marketing", label: "Marketing", dept: "Marketing Department", prefix: "A" },
  { key: "class_registration", label: "Class Registration", dept: "Timetable", prefix: "A" },
  { key: "tuition_payment", label: "Tuition Payment", dept: "Fees", prefix: "A" },
  { key: "student_id", label: "Student ID", dept: "Library", prefix: "A" },
];

const makeTicketId = (() => {
  // Human-friendly sequential tickets per day; switch to DB later if needed.
  let seq = 1000;
  return (prefix = "A") => `${prefix}${++seq}`;
})();

// In-memory state (swap for a DB later)
const students = new Map(); // ticket -> student
const queues = new Map(steps.map(s => [s.key, []])); // stepKey -> [ticket]
const currentServing = new Map(steps.map(s => [s.key, null])); // stepKey -> ticket|null
const holds = new Map(steps.map(s => [s.key, new Set()])); // stepKey -> Set<ticket>

// Helpers
const stepIndexByKey = new Map(steps.map((s, i) => [s.key, i]));
const nextStepKey = (key) => {
  const i = stepIndexByKey.get(key);
  if (i == null) return null;
  return steps[i + 1]?.key ?? null;
};

const publicState = () => ({
  steps,
  queues: Object.fromEntries([...queues.entries()]),
  currentServing: Object.fromEntries([...currentServing.entries()]),
});

const emitState = () => {
  io.emit("state:update", publicState());
};

const emitStudent = (ticket) => {
  const student = students.get(ticket);
  if (student) io.emit("student:update", student);
};

// API

// Student check-in (captured at Registration desk)
app.post("/api/checkin", (req, res) => {
  const { name, studentId, program, email } = req.body || {};
  if (!name || !program) {
    return res.status(400).json({ error: "name and program are required" });
  }

  const regStep = steps[0];
  const ticket = makeTicketId(regStep.prefix);

  const student = {
    ticket,
    name,
    studentId: studentId || null,
    program,
    email: email || null,
    stepKey: regStep.key,     // current step
    status: "queued",         // queued | serving | hold | complete
    history: [],              // array of { stepKey, action, ts }
    createdAt: new Date().toISOString(),
  };

  students.set(ticket, student);
  queues.get(regStep.key).push(ticket);
  student.history.push({ stepKey: regStep.key, action: "checkin", ts: new Date().toISOString() });

  emitState();
  emitStudent(ticket);

  res.json({ ticket, stepKey: regStep.key, steps });
});

// Department pulls next student if none serving
app.post("/api/department/:step/start-next", (req, res) => {
  const stepKey = req.params.step;
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
    student.history.push({ stepKey, action: "start", ts: new Date().toISOString() });
  }

  emitState();
  emitStudent(ticket);
  res.json({ ticket });
});

// Mark completed at a step -> enqueue to next step (if any)
app.post("/api/department/:step/complete", (req, res) => {
  const stepKey = req.params.step;
  const serving = currentServing.get(stepKey);
  if (!serving) return res.status(409).json({ error: "No student currently serving" });

  const student = students.get(serving);
  if (!student) return res.status(404).json({ error: "Student not found" });

  student.history.push({ stepKey, action: "complete", ts: new Date().toISOString() });

  // Clear current
  currentServing.set(stepKey, null);

  // Move to next
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

// Put current student on hold at this step
app.post("/api/department/:step/hold", (req, res) => {
  const stepKey = req.params.step;
  const serving = currentServing.get(stepKey);
  if (!serving) return res.status(409).json({ error: "No student currently serving" });

  currentServing.set(stepKey, null);

  const student = students.get(serving);
  if (student) {
    student.status = "hold";
    student.history.push({ stepKey, action: "hold", ts: new Date().toISOString() });
    holds.get(stepKey).add(serving);
  }

  emitState();
  emitStudent(serving);
  res.json({ ok: true });
});

// Return a held student back to queue
app.post("/api/department/:step/return/:ticket", (req, res) => {
  const stepKey = req.params.step;
  const { ticket } = req.params;
  if (!holds.get(stepKey).has(ticket)) {
    return res.status(404).json({ error: "Ticket not on hold at this step" });
  }
  holds.get(stepKey).delete(ticket);
  queues.get(stepKey).push(ticket);

  const student = students.get(ticket);
  if (student) {
    student.status = "queued";
    student.history.push({ stepKey, action: "return", ts: new Date().toISOString() });
  }

  emitState();
  emitStudent(ticket);
  res.json({ ok: true });
});

// Skip: send current back to end of queue
app.post("/api/department/:step/skip", (req, res) => {
  const stepKey = req.params.step;
  const serving = currentServing.get(stepKey);
  if (!serving) return res.status(409).json({ error: "No student currently serving" });

  currentServing.set(stepKey, null);
  queues.get(stepKey).push(serving);

  const student = students.get(serving);
  if (student) {
    student.status = "queued";
    student.history.push({ stepKey, action: "skip", ts: new Date().toISOString() });
  }

  emitState();
  emitStudent(serving);
  res.json({ ok: true });
});

// Read-only endpoints
app.get("/api/status", (req, res) => {
  res.json(publicState());
});

app.get("/api/student/:ticket", (req, res) => {
  const student = students.get(req.params.ticket);
  if (!student) return res.status(404).json({ error: "Not found" });
  res.json(student);
});

// WebSocket connections
io.on("connection", (socket) => {
  socket.emit("state:update", publicState());
  socket.on("disconnect", () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Enrolment queue running on http://localhost:${PORT}`);
  console.log(`Open the UI:`);
  console.log(`  Student Check-in:     http://localhost:${PORT}/index.html`);
  console.log(`  Public Display:       http://localhost:${PORT}/display.html`);
  console.log(`  Department Dashboard: http://localhost:${PORT}/dashboard.html?dept=registration`);
  console.log(`  Student Progress:     http://localhost:${PORT}/progress.html?ticket=A1001`);
});
