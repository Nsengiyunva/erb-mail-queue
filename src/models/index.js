// models/index.js
import Sequelize from 'sequelize';
import FileBatch from './FileBatch.js';
import ProcessedFile from './ProcessedFile.js';
import EmailLogModel from './EmailLog.js'; // note renaming
import { sequelize } from '../config/database.js';

// Initialize EmailLog properly
const EmailLog = EmailLogModel(sequelize, Sequelize.DataTypes);

// Associations
FileBatch.hasMany(ProcessedFile, { foreignKey: 'batchId' });
ProcessedFile.belongsTo(FileBatch, { foreignKey: 'batchId' });

// Export initialized models
export {
  sequelize,
  FileBatch,
  ProcessedFile,
  EmailLog
};
