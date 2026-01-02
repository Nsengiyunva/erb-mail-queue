// models/FileBatch.js
import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

const FileBatch = sequelize.define('FileBatch', {
  batchId: {
    type: DataTypes.STRING,
    primaryKey: true
  },
  totalFiles: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  processedFiles: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  status: {
    type: DataTypes.ENUM('pending', 'processing', 'completed', 'failed'),
    defaultValue: 'pending'
  },
  completedAt: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'erb_file_batches',
  timestamps: true
});

export default FileBatch;
