export default (sequelize, DataTypes) => {
    return sequelize.define(
      'EmailLog',
      {
        job_id: DataTypes.STRING,
        recipient_email: {
          type: DataTypes.STRING,
          allowNull: false
        },
        registration_no: DataTypes.STRING,
        status: {
          type: DataTypes.ENUM('PENDING', 'SENT', 'FAILED'),
          allowNull: false
        },
        error_message: DataTypes.TEXT,
        sent_at: DataTypes.DATE
      },
      {
        tableName: 'erb_email_logs',
        underscored: true
      }
    );
  };
  