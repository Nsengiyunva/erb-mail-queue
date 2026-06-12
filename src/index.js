// import express from "express";
// import * as dotenv from "dotenv";
// import cors from "cors";


// // Routes
// import emailRoutes from "./routes/email_routes.js";
// import fileRoutes from "./routes/file_routes.js";
// import monitorRoutes from "./routes/monitor_routes.js";
// import receiptRoutes from "./routes/receipt_routes.js";
// import reportRoutes from "./routes/report_routes.js";
// import applicationRoutes from './routes/application_routes.js'

// // Workers
// import "./workers/email_workers.js";
// import "./workers/file_worker.js";
// import "./workers/file_process_worker.js";
// import "./workers/file_monitor_worker.js";
// import "./workers/receipt_worker.js";
// import "./workers/report_worker.js";
// import "./workers/application_worker.js";

// dotenv.config();

// const app = express();
// const PORT =  8854;

// // Trust proxy (NGINX)
// app.set("trust proxy", true);

// // --------------------
// // CORS CONFIG
// // --------------------
// const allowedOrigins = [
//   "http://localhost:3000",
//   "https://registration.erb.go.ug"
// ];

// const corsOptions = {
//   origin: function (origin, callback) {
//     if (!origin) return callback(null, true);

//     if (allowedOrigins.includes(origin)) {
//       return callback(null, true);
//     } else {
//       return callback(new Error("Not allowed by CORS"));
//     }
//   },
//   credentials: true,
//   methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
//   allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
// };

// // Apply CORS globally
// app.use(cors(corsOptions));

// app.options("/{*path}", cors(corsOptions));

// // Body parsers
// app.use(express.json());
// app.use(express.urlencoded({ extended: true }));


// app.use((req, res, next) => {
//   if (req.headers['x-forwarded-proto'] === 'http') {  // ← only redirect when coming through nginx
//     return res.redirect(301, `https://${req.headers.host}${req.url}`);
//   }
//   next();
// });

// // --------------------
// // Routes
// // --------------------
// app.get("/api/erb/health", (req, res) => {
//   res.status(200).json({
//     status: "ok",
//     service: "erb-api",
//     timestamp: new Date().toISOString(),
//   });
// });

// app.use("/api/erb/email", emailRoutes);
// app.use("/api/erb/file", fileRoutes);
// app.use("/api/erb/monitor", monitorRoutes);
// app.use("/api/erb/receipt", receiptRoutes);
// app.use("/api/erb/report", reportRoutes);
// app.use("/api/erb/application", applicationRoutes);


// // 404 fallback
// app.use((_, res) => {
//   res.status(404).json({ error: "Endpoint not found" });
// });

// // Start server
// app.listen(PORT, "0.0.0.0", () => {
//   console.log(`✅ Server running on port ${PORT}`);
// });



import express         from "express";
import * as dotenv     from "dotenv";
import cors            from "cors";
import { createServer } from "http";
import { Server }       from "socket.io";

// Routes
import emailRoutes       from "./routes/email_routes.js";
import fileRoutes        from "./routes/file_routes.js";
import monitorRoutes     from "./routes/monitor_routes.js";
import receiptRoutes     from "./routes/receipt_routes.js";
import reportRoutes      from "./routes/report_routes.js";
import applicationRoutes from "./routes/application_routes.js";

// Workers
import "./workers/email_workers.js";
import "./workers/file_worker.js";
import "./workers/file_process_worker.js";
import "./workers/file_monitor_worker.js";
import "./workers/receipt_worker.js";
import "./workers/report_worker.js";
import "./workers/application_worker.js";

dotenv.config();

const app  = express();
const PORT = 8854;

// Trust proxy (nginx terminates TLS)
app.set("trust proxy", true);

// ── CORS ──────────────────────────────────────────────────────────
const allowedOrigins = [
  "http://localhost:3000",
  "https://registration.erb.go.ug",
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  // x-watcher-secret needed for the VM1 payment watcher push
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "x-watcher-secret"],
};

app.use(cors(corsOptions));
app.options("/{*path}", cors(corsOptions));

// ── Body parsers ──────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    service:   "erb-api",
    timestamp: new Date().toISOString(),
  });
});

// ── Routes ────────────────────────────────────────────────────────
app.use("/api/erb/email",       emailRoutes);
app.use("/api/erb/file",        fileRoutes);
app.use("/api/erb/monitor",     monitorRoutes);
app.use("/api/erb/receipt",     receiptRoutes);
app.use("/api/erb/report",      reportRoutes);
app.use("/api/erb/application", applicationRoutes);

// ── Payment-update webhook (called by VM1 payment watcher) ───────
// Placed here so it has direct access to `io` without circular imports.
const WATCHER_SECRET = process.env.WATCHER_SECRET;

app.post("/api/erb/receipt/payment-update", (req, res) => {
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
// Must wrap express in createServer so socket.io and HTTP share port 8854.
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


