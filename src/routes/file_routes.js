import { Queue } from "bullmq";
import Redis from "ioredis";
import path from "path";
import express from 'express';
// import fs from 'fs';
import multer from "multer";
import fileQueue from '../queues/file_queues'



const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post("/upload-license", upload.single("file"), async (req, res) => {
    const { file } = req;
    const { rowId } = req.body;
  
    if (!file || !rowId) return res.status(400).json({ message: "Missing file or rowId" });
  
    // Push job to queue
    await fileQueue.add("uploadPDF", {
      buffer: file.buffer,
      originalName: file.originalname,
      rowId,
    });
  
    res.json({ message: "File upload queued successfully" });
  });