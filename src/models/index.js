// models/index.js
import FileBatch from './FileBatch.js';
import ProcessedFile from './ProcessedFile.js';
import EmailLog from './EmailLog.js';
import { sequelize } from '../config/database.js';


FileBatch.hasMany(ProcessedFile, { foreignKey: 'batchId' });
ProcessedFile.belongsTo(FileBatch, { foreignKey: 'batchId' });

export {
  sequelize,
  FileBatch,
  ProcessedFile,
  EmailLog
};
