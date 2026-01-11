
// import express from "express";
// import * as dotenv from 'dotenv'
// import emailRoutes from './routes/email_routes.js'
// import fileRoutes from './routes/file_routes.js'

// import monitorRoutes from './routes/monitor_routes.js';

// import './workers/email_workers.js'
// import './workers/file_worker.js'
// import './workers/file_process_worker.js';
// import './workers/file_monitor_worker.js';

// import listEndpoints from 'express-list-endpoints';

// import cors from 'cors'

// import { connectDB } from "./config/database.js";

// dotenv.config();

// connectDB();

// const app = express();
// const PORT = 8782;
   
// app.use(express.json());

// app.use( cors() );

// app.use(function (_, res, next) {
//   res.header("Access-Control-Allow-Origin", "*"); 
//   res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
//   res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
//   res.header("Access-Control-Allow-Credentials", "true");
//   next();
// });


// console.log("here-1",listEndpoints(app));

// app.use('/api/erb/email', emailRoutes);
// app.use('/api/erb/file', fileRoutes);

// // app.use('/test/erb/', monitorRoutes);

// app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

import express from "express";
import * as dotenv from "dotenv";
import cors from "cors";

// Routes
import emailRoutes from "./routes/email_routes.js";
import fileRoutes from "./routes/file_routes.js";
import monitorRoutes from "./routes/monitor_routes.js";
import receiptRoutes from "./routes/receipt_routes.js";

// Workers
import "./workers/email_workers.js";
import "./workers/file_worker.js";
import "./workers/file_process_worker.js";
import "./workers/file_monitor_worker.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8782;

// Trust proxy (NGINX)
app.set("trust proxy", true);

// --------------------
// ✅ CORS (MUST BE FIRST)
// --------------------
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://helper.erb.go.ug",
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// ✅ Explicit OPTIONS handler
app.options("*", cors());

// --------------------
// Body parsers
// --------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --------------------
// 🔐 HTTPS redirect (NOT for OPTIONS)
// --------------------
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  if (req.protocol === "http") {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }

  next();
});

// --------------------
// Routes
// --------------------
app.use("/api/erb/email", emailRoutes);
app.use("/api/erb/file", fileRoutes);
app.use("/api/erb/monitor", monitorRoutes);
app.use("/api/erb/receipt", receiptRoutes);

// Test route
app.get("/api/test", (_, res) => res.json({ ok: true }));

// 404 fallback
app.use((_, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

