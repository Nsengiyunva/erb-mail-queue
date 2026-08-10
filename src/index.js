import express         from "express";
import * as dotenv     from "dotenv";
import cors            from "cors";
import fs              from "fs";
import path            from "path";
import { createServer } from "http";
import { Server }       from "socket.io";

// Routes
import emailRoutes       from "./routes/email_routes.js";
import fileRoutes        from "./routes/file_routes.js";
import monitorRoutes     from "./routes/monitor_routes.js";
import receiptRoutes     from "./routes/receipt_routes.js";
import reportRoutes      from "./routes/report_routes.js";
import applicationRoutes from "./routes/application_routes.js";
import invoiceRoutes     from "./routes/invoice_routes.js";

import { PaymentTransaction, normaliseStatus } from "./controllers/receipt-controller.js";

// Workers
import "./workers/email_workers.js";
import "./workers/file_worker.js";
import "./workers/file_process_worker.js";
import "./workers/file_monitor_worker.js";
import "./workers/receipt_worker.js";
import "./workers/report_worker.js";
import "./workers/application_worker.js";
import "./workers/invoice_worker.js";
import "./workers/sponsor_notification_worker.js";

dotenv.config();

const app  = express();
const PORT = 8854;

// Absolute path to the uploads directory
const UPLOADS_DIR = path.resolve("/home/user1/uploads");

// Trust proxy (nginx terminates TLS)
app.set("trust proxy", true);

// ── CORS ──────────────────────────────────────────────────────────
const allowedOrigins = [
  "http://localhost:3000",
  "https://registration.erb.go.ug",
  "https://data.erb.go.ug",
  "https://erb.go.ug"
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "x-watcher-secret", "x-user-role", "x-applicant-id"],
};

app.use(cors(corsOptions));
app.options("/{*path}", cors(corsOptions));

// ── Body parsers ──────────────────────────────────────────────────
// Default express.json() limit is 100kb. The application wizard now
// autosaves the full draft (education/engineering/training/positions/
// membership/sponsors, all JSON-stringified) on every step, which can
// exceed that easily — and when it does, express.json() silently skips
// parsing rather than erroring, leaving req.body undefined downstream.
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ── HTTPS redirect — x-forwarded-proto only, never req.protocol ──
// req.protocol is always 'http' behind nginx, causing an infinite loop.
app.use((req, res, next) => {
  if (req.headers["x-forwarded-proto"] === "http") {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

// ── Health ────────────────────────────────────────────────────────
app.get("/api/erb/health", (_req, res) => {
  res.status(200).json({
    status:    "ok",
    service:   "erb-helper",
    timestamp: new Date().toISOString(),
  });
});


app.get("/api/erb/uploads/:filename", (req, res) => {
  const { filename } = req.params;

  // Guard against path traversal attacks
  if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return res.status(400).json({ message: "Invalid filename" });
  }

  const filePath = path.join(UPLOADS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ message: "File not found" });
  }

  const ext   = path.extname(filename).toLowerCase();
  const isPdf = ext === ".pdf";

  // inline → browser renders in tab; attachment → download prompt
  res.setHeader(
    "Content-Disposition",
    isPdf
      ? `inline; filename="${filename}"`
      : `attachment; filename="${filename}"`
  );

  res.sendFile(filePath, (err) => {
    if (err) {
      console.error("[uploads] sendFile error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ message: "Failed to serve file" });
      }
    }
  });
});

// ── Routes ────────────────────────────────────────────────────────
app.use("/api/erb/email",       emailRoutes);
app.use("/api/erb/file",        fileRoutes);
app.use("/api/erb/monitor",     monitorRoutes);
app.use("/api/erb/receipt",     receiptRoutes);
app.use("/api/erb/report",      reportRoutes);
app.use("/api/erb/application", applicationRoutes);
app.use("/api/erb/invoice",     invoiceRoutes);

// ── Payment-update webhook (called by VM1 payment watcher) ───────
// Placed here so it has direct access to `io` without circular imports.
const WATCHER_SECRET = 'bnNlbmdpeXVudmE6a2luZ0AjMjAyME5TRQ==';


app.post("/api/erb/receipt/payment-update", async (req, res) => {
  const secret = req.headers["x-watcher-secret"];

  if (!WATCHER_SECRET || secret !== WATCHER_SECRET) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const { request_id, status, amount, notes } = req.body;

  if (!request_id || !status) {
    return res.status(400).json({ message: "request_id and status are required" });
  }

  // ACK immediately so VM1 watcher does not block
  res.status(200).json({ received: true });

  // Normalise the incoming status to the table's canonical states
  const dbStatus = normaliseStatus(status);

  try {
    const [affected] = await PaymentTransaction.update(
      {
        status: dbStatus,
        ...(amount != null ? { amount } : {}),
      },
      { where: { transaction_ref: String(request_id) } }
    );

    if (affected === 0) {
      console.warn(`[payment-update] no row matched transaction_ref=${request_id}`);
    } else {
      console.log(`[payment-update] DB updated ${request_id} → ${dbStatus} (${affected} row)`);
    }
  } catch (err) {
    // Don't fail the request — we've already ACKed. Just log it.
    console.error(`[payment-update] DB update failed for ${request_id}:`, err.message);
  }

  // Push to the browser that joined room payment:{request_id}
  io.to(`payment:${request_id}`).emit("payment:update", {
    transactionRef: request_id,
    status:         status.toLowerCase(),
    amount,
    notes: notes || null,
  });

  console.log(`[payment-update] ${request_id} → ${status}`);
});

// ── 404 fallback ──────────────────────────────────────────────────
app.use((_, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// ── HTTP server + Socket.io ───────────────────────────────────────
const httpServer = createServer(app);

export const io = new Server(httpServer, {
  cors: {
    origin:      allowedOrigins,
    credentials: true,
  },
});

io.on("connection", (socket) => {
  // Frontend emits: socket.emit('watch:payment', { transactionRef: txRef })
  socket.on("watch:payment", ({ transactionRef }) => {
    if (!transactionRef) return;
    socket.join(`payment:${transactionRef}`);
    console.log(`[socket] watching payment:${transactionRef}`);
  });

  socket.on("disconnect", () => {
    console.log("[socket] client disconnected");
  });
});

// ── Start ─────────────────────────────────────────────────────────
// Use httpServer.listen, NOT app.listen — otherwise socket.io won't work.
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
});
