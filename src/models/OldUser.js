// old_users — the portal account table (data.erb.go.ug /old/users).
// Only the columns erb-helper writes are modelled here. NOT synced: this
// model never creates or alters the table.
//
// Updated when Registration confirms an application (POST /finalize):
//   registered = "Yes", licence_no = issued number, type = PERMANENT |
//   TEMPORARY | TECHNOLOGIST | TECHNICIAN.
// Matched by id (= erb_applications.applicant_id), falling back to email.
export default (sequelize, DataTypes) => {
  return sequelize.define(
    'OldUser',
    {
      id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      email:      DataTypes.STRING,
      registered: DataTypes.STRING, // "Yes" / "No"
      licence_no: DataTypes.STRING,
      type:       DataTypes.STRING, // PERMANENT | TEMPORARY | TECHNOLOGIST | TECHNICIAN
    },
    {
      tableName:  'old_users',
      timestamps: false,
    }
  );
};
