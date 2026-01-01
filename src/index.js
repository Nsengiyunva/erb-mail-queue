
import express from "express";
import * as dotenv from 'dotenv'
import emailRoutes from './routes/email_routes.js'
import './workers/email_workers.js'

dotenv.config();

const app = express();
const PORT = 8782;
   
app.use(express.json());

app.use(function (_, res, next) {
  res.header("Access-Control-Allow-Origin", "*"); 
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.header("Access-Control-Allow-Credentials", "true");
  next();
});

app.use('/api/erb/email', emailRoutes);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
