// One row per entry in an application's comments thread — shared by the
// admin "Pending Applications" detail modal and the applicant's own
// application page. Holds both free-text messages (event = 'COMMENT') and
// the pipeline decisions that carry a comment (payment verified, sent back,
// board approved, resubmitted), so the whole conversation around an
// application reads top-to-bottom in one place instead of being scattered
// across accounts_comment / defer_comment / board_comment — which only ever
// hold the *latest* value and lose history every time an application is
// sent back more than once.
export default (sequelize, DataTypes) => {
  return sequelize.define(
    'ApplicationComment',
    {
      id: {
        type:          DataTypes.BIGINT,
        primaryKey:    true,
        autoIncrement: true,
      },
      application_id: {
        type:      DataTypes.BIGINT,
        allowNull: false,
      },
      // 'ADMIN' | 'APPLICANT' | 'SYSTEM'
      author_type: {
        type:         DataTypes.STRING(20),
        allowNull:    false,
        defaultValue: 'ADMIN',
      },
      author_name: DataTypes.STRING,
      // Admin `level` (ACCOUNTS / REGISTRATION / REGISTRAR / CHAIRMAN), or
      // null for applicants.
      author_role: DataTypes.STRING(40),
      author_id:   DataTypes.STRING(64),
      // 'COMMENT' | 'PAYMENT_VERIFIED' | 'SENT_BACK' | 'BOARD_APPROVED' | 'RESUBMITTED'
      event: {
        type:         DataTypes.STRING(40),
        allowNull:    false,
        defaultValue: 'COMMENT',
      },
      // 'ALL' → visible to the applicant too. 'INTERNAL' → admins only.
      visibility: {
        type:         DataTypes.STRING(20),
        allowNull:    false,
        defaultValue: 'ALL',
      },
      message: {
        type:      DataTypes.TEXT,
        allowNull: false,
      },
    },
    {
      tableName:  'erb_application_comments',
      timestamps: true,
      createdAt:  'created_at',
      updatedAt:  'updated_at',
      indexes: [{ fields: ['application_id'] }],
    }
  )
}
