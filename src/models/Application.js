export default (sequelize, DataTypes) => {
    return sequelize.define(
      'Application',
      {
        id: { 
          type: DataTypes.BIGINT, 
          primaryKey: true, 
          autoIncrement: true 
        },
        applicant_id: DataTypes.INTEGER,
        name: DataTypes.STRING,
        first_name: DataTypes.STRING,
        surname: DataTypes.STRING,
        other_names: DataTypes.STRING,

        email_address: DataTypes.STRING,
        telephone: DataTypes.STRING,
        registered_phone_number: DataTypes.STRING,
        provided_number: DataTypes.STRING,

        gender: DataTypes.STRING,
        birth_date: DataTypes.DATEONLY,
        birth_place: DataTypes.STRING,

        nationality: DataTypes.STRING,
        country: DataTypes.STRING,
        address: DataTypes.STRING,

        category: DataTypes.STRING,
        profession: DataTypes.STRING,
        type: DataTypes.STRING,

        document_type: DataTypes.STRING,
        document_id: DataTypes.STRING,

        ever_convicted: DataTypes.STRING,
        conviction_details: DataTypes.TEXT,

        education: DataTypes.TEXT,
        engineering: DataTypes.TEXT,
        membership: DataTypes.TEXT,
        training: DataTypes.TEXT,
        positions: DataTypes.TEXT,
        sponsors: DataTypes.TEXT,

        technical_path:  DataTypes.STRING,
        career_path:  DataTypes.STRING,

        status: {
            type: DataTypes.STRING,
            defaultValue: "PENDING",
        },
      },
      {
        tableName: "erb_applications",
        timestamps: true,
        createdAt: "created_at",
        updatedAt: false,
      }
    );
  };