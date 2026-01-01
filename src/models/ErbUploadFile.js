export default (sequelize, DataTypes) => {
    return sequelize.define(
      "ErbUploadFile",
      {
        id: {
          type: DataTypes.BIGINT,
          primaryKey: true,
          autoIncrement: true,
        },
        row_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
        },
        file_path: {
          type: DataTypes.STRING,
          allowNull: false,
        },
        original_name: {
          type: DataTypes.STRING,
          allowNull: false,
        },
      },
      {
        tableName: "erb_upload_files",
        timestamps: true,
        createdAt: "created_at",
        updatedAt: false,
      }
    );
  };
  