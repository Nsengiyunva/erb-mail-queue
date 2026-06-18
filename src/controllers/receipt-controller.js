// controllers/receipt_controller.js
export const saveTransaction = async (req, res) => {
    const {
      application_id, transaction_ref, phone,
      provider, amount, applicant_name, applicant_id, status,
    } = req.body
  
    if (!application_id || !transaction_ref) {
      return res.status(400).json({ message: 'application_id and transaction_ref are required' })
    }
  
    try {
      await db.query(
        `INSERT INTO payment_transactions
           (application_id, transaction_ref, phone, provider, amount, applicant_name, applicant_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE status = VALUES(status)`,
        [application_id, transaction_ref, phone, provider, amount, applicant_name, applicant_id, status]
      )
      res.json({ saved: true })
    } catch (err) {
      console.error('[save-transaction]', err)
      res.status(500).json({ message: 'Failed to save transaction' })
    }
  }