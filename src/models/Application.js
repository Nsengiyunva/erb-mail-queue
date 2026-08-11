// export default (sequelize, DataTypes) => {
//     return sequelize.define(
//       'Application',
//       {
//         id: { 
//           type: DataTypes.BIGINT, 
//           primaryKey: true, 
//           autoIncrement: true 
//         },
//         applicant_id: DataTypes.INTEGER,
//         draft_type: DataTypes.STRING,
//         name: DataTypes.STRING,
//         first_name: DataTypes.STRING,
//         surname: DataTypes.STRING,
//         other_names: DataTypes.STRING,

//         email_address: DataTypes.STRING,
//         telephone: DataTypes.STRING,
//         registered_phone_number: DataTypes.STRING,
//         provided_number: DataTypes.STRING,

//         gender: DataTypes.STRING,
//         birth_date: DataTypes.DATEONLY,
//         birth_place: DataTypes.STRING,

//         nationality: DataTypes.STRING,
//         country: DataTypes.STRING,
//         address: DataTypes.STRING,

//         category: DataTypes.STRING,
//         profession: DataTypes.STRING,
//         type: DataTypes.STRING,

//         document_type: DataTypes.STRING,
//         document_id: DataTypes.STRING,

//         ever_convicted: DataTypes.STRING,
//         conviction_details: DataTypes.TEXT,

//         education: DataTypes.TEXT,
//         engineering: DataTypes.TEXT,
//         membership: DataTypes.TEXT,
//         training: DataTypes.TEXT,
//         positions: DataTypes.TEXT,
//         sponsors: DataTypes.TEXT,

//         technical_path:  DataTypes.STRING,
//         career_path:  DataTypes.STRING,

//         status: {
//             type: DataTypes.STRING,
//             defaultValue: "PENDING",
//         },
//       },
//       {
//         tableName: "erb_applications",
//         timestamps: true,
//         createdAt: "created_at",
//         updatedAt: false,
//       }
//     );
//   };


export default (sequelize, DataTypes) => {
  return sequelize.define(
    'Application',
    {
      id: {
        type:          DataTypes.BIGINT,
        primaryKey:    true,
        autoIncrement: true,
      },
      applicant_id:            DataTypes.INTEGER,
      draft_type:              DataTypes.STRING,
      name:                    DataTypes.STRING,
      first_name:              DataTypes.STRING,
      surname:                 DataTypes.STRING,
      other_names:             DataTypes.STRING,
      email_address:           DataTypes.STRING,
      telephone:               DataTypes.STRING,
      registered_phone_number: DataTypes.STRING,
      provided_number:         DataTypes.STRING,
      gender:                  DataTypes.STRING,
      birth_date:              DataTypes.DATEONLY,
      birth_place:             DataTypes.STRING,
      nationality:             DataTypes.STRING,
      country:                 DataTypes.STRING,
      address:                 DataTypes.STRING,
      category:                DataTypes.STRING,
      profession:              DataTypes.STRING,
      type:                    DataTypes.STRING,
      document_type:           DataTypes.STRING,
      document_id:             DataTypes.STRING,
      ever_convicted:          DataTypes.STRING,
      conviction_details:      DataTypes.TEXT,
      education:               DataTypes.TEXT,
      engineering:             DataTypes.TEXT,
      membership:              DataTypes.TEXT,
      training:                DataTypes.TEXT,
      positions:               DataTypes.TEXT,
      sponsors:                DataTypes.TEXT,
      technical_path:          DataTypes.STRING,
      career_path:             DataTypes.STRING,
      uipe_membership_letter_path:      DataTypes.STRING,
      uipe_membership_certificate_path: DataTypes.STRING,
      academic_certificates_path:       DataTypes.STRING,
      transcripts_path:                 DataTypes.STRING,
      uneb_certificates_path:           DataTypes.STRING,
      verification_letters_path:        DataTypes.STRING,
      other_qualifications_path:        DataTypes.STRING,
      employment_letters_path:          DataTypes.STRING,
      organogram_path:                  DataTypes.STRING,
      cpd_path:                         DataTypes.STRING,
      passport_photo_1_path:            DataTypes.STRING,
      passport_photo_2_path:            DataTypes.STRING,
      // Populated when a Registration-level admin approves an application
      // on behalf of the Board (see /board_approve). NULL for applications
      // the Board reviewed itself, once that flow exists separately.
      board_comment:                    DataTypes.TEXT,
      board_approved_by:                DataTypes.STRING,
      board_approved_at:                DataTypes.DATE,
      status: {
        type:         DataTypes.STRING,
        defaultValue: 'PENDING',
      },
    },
    {
      tableName:  'erb_applications',
      timestamps:  true,
      createdAt:  'created_at',
      updatedAt:  'updated_at'
    }
  )
}