// ── ASSUMPTION — please confirm ──────────────────────────────────────
// Nothing in this codebase modeled `old_users` before now, so the
// columns below are a best guess from the request itself ("registered
// field", "add a licence number"). Before relying on this in
// production, please confirm against the real table:
//   - the join key used to find an applicant's old_users row (this
//     currently matches on `email`, in board_approve's OldUser.findOne()
//     call in application_routes.js — swap to whatever key is actually
//     shared with erb_applications, e.g. an applicant/user id, if
//     `email` isn't it)
//   - the exact column names for the "registered" flag and the licence
//     number (guessed here as `registered` and `license_number`)
export default (sequelize, DataTypes) => {
  return sequelize.define(
    'OldUser',
    {
      id:             { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      email:          DataTypes.STRING,
      registered:     DataTypes.STRING, // expected values: "Yes" / "No"
      license_number: DataTypes.STRING,
    },
    {
      tableName:  'old_users',
      timestamps: false,
    }
  );
};
