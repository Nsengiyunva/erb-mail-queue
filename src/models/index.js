// models/index.js
import Sequelize from 'sequelize';
import FileBatch from './FileBatch.js';
import ProcessedFile from './ProcessedFile.js';
import EmailLogModel from './EmailLog.js';
import ApplicationModel from './Application.js'; // ← renamed to clarify it's a factory
import { sequelize } from '../config/database.js';

// Initialize models that use factory pattern
const EmailLog = EmailLogModel(sequelize, Sequelize.DataTypes);
const Application = ApplicationModel(sequelize, Sequelize.DataTypes); // ← add this

// Associations
FileBatch.hasMany(ProcessedFile, { foreignKey: 'batchId' });
ProcessedFile.belongsTo(FileBatch, { foreignKey: 'batchId' });

// Export initialized models
export {
  sequelize,
  FileBatch,
  ProcessedFile,
  EmailLog,
  Application
};