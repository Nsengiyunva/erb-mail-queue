// watchers/registrad_watcher.js
import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs/promises';
import fileMonitorQueue from '../queues/file_monitor_queue.js';

const WATCH_DIR = '/home/user1/ERB/registrad';

chokidar.watch(WATCH_DIR, {
  ignoreInitial: true,
  awaitWriteFinish: true
}).on('add', async filePath => {
  const stats = await fs.stat(filePath);

  await fileMonitorQueue.add('external-file', {
    filename: path.basename(filePath),
    path: filePath,
    size: stats.size
  });
});
