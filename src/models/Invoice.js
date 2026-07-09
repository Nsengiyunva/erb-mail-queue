export default (sequelize, DataTypes) => {
  const Invoice = sequelize.define(
    "Invoice",
    {
      id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },

      invoice_no: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },

      invoice_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },

      engineer_name: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },

      erb_no: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },

      address: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

      email: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },

      financial_year: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },

      arrears_year: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },

      annual_fee_engineers: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },

      annual_fee_rate: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0,
      },

      arrears_amount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0,
      },

      surcharge_percent: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: false,
        defaultValue: 0,
      },

      // Derived figures, computed and frozen at save time so the saved
      // record always reflects exactly what was on the generated PDF,
      // even if the fee rate or surcharge rule changes later.
      annual_fee_amount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0,
      },

      surcharge_amount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0,
      },

      total_amount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0,
      },

      file_name: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },

      original_name: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },

      file_path: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },

      status: {
        type: DataTypes.ENUM("saved", "pending", "sent", "failed"),
        allowNull: false,
        defaultValue: "saved",
      },

      sent_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: "erb_invoices",
      timestamps: true,
      createdAt: "created_at",
      updatedAt: "updated_at",
    }
  );

  return Invoice;
};
