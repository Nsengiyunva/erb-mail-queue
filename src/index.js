import express from "express";
import * as dotenv from "dotenv";
import cors from "cors";

// Routes
import emailRoutes from "./routes/email_routes.js";
import fileRoutes from "./routes/file_routes.js";
import monitorRoutes from "./routes/monitor_routes.js";
import receiptRoutes from "./routes/receipt_routes.js";
import reportRoutes from "./routes/report_routes.js";
import applicationRoutes from './routes/application_routes.js'

// Workers
// import "./workers/email_workers.js";
// import "./workers/file_worker.js";
// import "./workers/file_process_worker.js";
// import "./workers/file_monitor_worker.js";
// import "./workers/receipt_worker.js";
// import "./workers/report_worker.js";
// import "./workers/application_worker.js";

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

// HTTPS redirect
app.use((req, res, next) => {
  if (req.protocol === "http") {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});


app.use((req, res, next) => {
  if (req.headers['x-forwarded-proto'] === 'http') {  // ← only redirect when coming through nginx
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

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






