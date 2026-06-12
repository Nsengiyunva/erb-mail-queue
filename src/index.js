import express from "express";
import * as dotenv from "dotenv";
import cors from "cors";
import { createServer } from 'http'
import { Server }       from 'socket.io'

// Routes
import emailRoutes from "./routes/email_routes.js";
import fileRoutes from "./routes/file_routes.js";
import monitorRoutes from "./routes/monitor_routes.js";
import receiptRoutes from "./routes/receipt_routes.js";
import reportRoutes from "./routes/report_routes.js";
import applicationRoutes from './routes/application_routes.js'

// Workers
import "./workers/email_workers.js";
import "./workers/file_worker.js";
import "./workers/file_process_worker.js";
import "./workers/file_monitor_worker.js";
import "./workers/receipt_worker.js";
import "./workers/report_worker.js";
import "./workers/application_worker.js";

dotenv.config();

const app = express();
const PORT =  8854;

// Trust proxy (NGINX)
app.set("trust proxy", true);

// --------------------
// CORS CONFIG
// --------------------
const allowedOrigins = [
  "http://localhost:3000",
  "https://registration.erb.go.ug"
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
};

// Apply CORS globally
app.use(cors(corsOptions));

app.options("/{*path}", cors(corsOptions));

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


app.use((req, res, next) => {
  if (req.headers['x-forwarded-proto'] === 'http') {  // ← only redirect when coming through nginx
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

//erb-payments-stanbic
const WATCHER_SECRET = process.env.WATCHER_SECRET

// ── WebSocket server ──────────────────────────────────────────────
const httpServer = createServer(app)

export const io = new Server(httpServer, {
  cors: {
    origin:      ['http://localhost:3000', 'https://registration.erb.go.ug'],
    credentials: true,
  },
})

// Rooms keyed by transactionRef — frontend joins on payment initiation
io.on('connection', (socket) => {
  socket.on('watch:payment', ({ request_id }) => {
    if (transactionRef) {
      socket.join(`payment:${request_id}`)
      console.log(`[socket] Client watching payment:${request_id}`)
    }
  })
  socket.on('disconnect', () => {
    console.log('[socket] Client disconnected')
  })
})


app.post('/api/erb/receipt/payment-update', (req, res) => {
  const secret = req.headers['x-watcher-secret']

  if (secret !== WATCHER_SECRET) {
    return res.status(403).json({ message: 'Forbidden' })
  }

  const { request_id, status, amount } = req.body

  if (!request_id || !status) {
    return res.status(400).json({ message: 'transactionRef and status required' })
  }

  // Immediately ACK the watcher — don't make VM1 wait
  res.status(200).json({ received: true })

  // Push to any browser watching this transactionRef
  io.to(`payment:${request_id}`).emit('payment:update', {
    transactionRef,
    status,
    amount,
    updatedAt,
  })

  console.log(`[erb-stanbic-payment] Relayed ${request_id} → ${status} to browser clients`)
})

// --------------------
// Routes
// --------------------
app.get("/api/erb/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "erb-api",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/erb/email", emailRoutes);
app.use("/api/erb/file", fileRoutes);
app.use("/api/erb/monitor", monitorRoutes);
app.use("/api/erb/receipt", receiptRoutes);
app.use("/api/erb/report", reportRoutes);
app.use("/api/erb/application", applicationRoutes);


// 404 fallback
app.use((_, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
});






