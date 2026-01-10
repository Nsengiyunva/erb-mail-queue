export default (sequelize, DataTypes) => {
    return sequelize.define(
      "Receipt",
      {
        id: {
          type: DataTypes.BIGINT,
          primaryKey: true,
          autoIncrement: true,
        },
  
        email: {
          type: DataTypes.STRING(255),
          allowNull: false,
        },
  
        file_name: {
          type: DataTypes.STRING(255),
          allowNull: false,
        },
  
        original_name: {
          type: DataTypes.STRING(255),
          allowNull: false,
        },
  
        file_path: {
          type: DataTypes.STRING,
          allowNull: false,
        },
  
        status: {
          type: DataTypes.ENUM("pending", "sent", "failed"),
          allowNull: false,
          defaultValue: "pending",
        },
      },
      {
        tableName: "erb_receipts",
        timestamps: true,
        createdAt: "created_at",
        updatedAt: false,
      }
    );
  }  