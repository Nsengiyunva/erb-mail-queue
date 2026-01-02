
import express from "express";
import * as dotenv from 'dotenv'
import emailRoutes from './routes/email_routes.js'
import fileRoutes from './routes/file_routes.js'

import monitorRoutes from './routes/monitor_routes.js';

import './workers/email_workers.js'
import './workers/file_worker.js'
import './workers/file_process_worker.js';
import './workers/file_monitor_worker.js';

import listEndpoints from 'express-list-endpoints';

import cors from 'cors'

import { connectDB } from "./config/database.js";

dotenv.config();

connectDB();

const app = express();
const PORT = 8782;
   
app.use(express.json());

app.use( cors() );

app.use(function (_, res, next) {
  res.header("Access-Control-Allow-Origin", "*"); 
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.header("Access-Control-Allow-Credentials", "true");
  next();
});


console.log("here-1",listEndpoints(app));

app.use('/api/erb/email', emailRoutes);
app.use('/api/erb/file', fileRoutes);

app.use( '/test/erb/', monitorRoutes)

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
