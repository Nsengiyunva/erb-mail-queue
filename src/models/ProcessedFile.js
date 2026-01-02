// models/ProcessedFile.js
import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

const ProcessedFile = sequelize.define('ProcessedFile', {
  id: {
    type: DataTypes.BIGINT,
    autoIncrement: true,
    primaryKey: true
  },
  batchId: {
    type: DataTypes.STRING,
    allowNull: false
  },
  originalName: {
    type: DataTypes.STRING,
    allowNull: false
  },
  filename: {
    type: DataTypes.STRING,
    allowNull: false
  },
  filePath: {
    type: DataTypes.STRING,
    allowNull: false
  },
  fileSize: {
    type: DataTypes.BIGINT,
    allowNull: false
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'completed'
  }
}, {
  tableName: 'erb_processed_files',
  timestamps: true
});

export default ProcessedFile;