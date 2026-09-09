// models/index.js
import Sequelize from 'sequelize';
import FileBatch from './FileBatch.js';
import ProcessedFile from './ProcessedFile.js';
import EmailLogModel from './EmailLog.js';
import ApplicationModel from './Application.js'; // ← renamed to clarify it's a factory
import OldUserModel from './OldUser.js';
import { sequelize } from '../config/database.js';

// Initialize models that use factory pattern
const EmailLog = EmailLogModel(sequelize, Sequelize.DataTypes);
const Application = ApplicationModel(sequelize, Sequelize.DataTypes); // ← add this
const OldUser = OldUserModel(sequelize, Sequelize.DataTypes);

// Adds accounts_receipt_email_status to erb_applications if it isn't there
// yet (same self-healing-schema pattern as PaymentTransaction.sync() in
// receipt-controller.js) — only ever ADDS columns, never drops/renames.
Application.sync({ alter: true }).catch(err =>
  console.error('[Application] sync error:', err.message)
);

// Associations
FileBatch.hasMany(ProcessedFile, { foreignKey: 'batchId' });
ProcessedFile.belongsTo(FileBatch, { foreignKey: 'batchId' });

// Export initialized models
export {
  sequelize,
  FileBatch,
  ProcessedFile,
  EmailLog,
  Application,
  OldUser
};