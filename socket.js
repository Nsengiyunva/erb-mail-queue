import { Server } from 'socket.io';
import http from 'http';
import express from 'express';

const app = express();
const server = http.createServer(app);

export const io = new Server(server, {
  cors: { origin: '*' },
});

server.listen(4000);