import PDFDocument from 'pdfkit'
import fs           from 'fs'
import path          from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'erb-logo.png')

// Where generated receipt PDFs are written. Override with RECEIPT_PDF_DIR
// in the environment if this should live somewhere else.
export const RECEIPT_PDF_DIR = process.env.RECEIPT_PDF_DIR || '/home/user1/ERB/receipts'

if (!fs.existsSync(RECEIPT_PDF_DIR)) {
  fs.mkdirSync(RECEIPT_PDF_DIR, { recursive: true })
}

const fmtUGX = (n) =>
  n == null ? '-' : `UGX ${Number(n).toLocaleString('en-UG', { maximumFractionDigits: 0 })}`

const fmtDate = (d) =>
  new Date(d || Date.now()).toLocaleString('en-UG', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })

// NOTE: REGISTRATION used to share a label with APPLICATION ("Application /
// Registration Fee") — that was inaccurate: APPLICATION is the fee paid at
// submission (SectionF.js), REGISTRATION is the separate annual
// registration fee paid after board approval (RegistrationInstantPayment.js).
// Split them out so the printed receipt matches which fee was actually paid.
const PURPOSE_LABEL = {
  APPLICATION:  'Application Fee',
  REGISTRATION: 'Annual Registration Fee',
  RENEWAL:      'Annual Renewal Fee',
}

/**
 * Renders a one-page PDF payment receipt for a PaymentTransaction-shaped
 * object and writes it to RECEIPT_PDF_DIR.
 *
 * @param {object} tx  Plain object (e.g. from PaymentTransaction.toJSON())
 *   Expected fields: transaction_ref, applicant_name, registration_number,
 *   application_id, amount, provider, phone, purpose, payment_method,
 *   status, createdAt/updatedAt.
 * @returns {Promise<string>} absolute path to the generated PDF
 */
export function generateReceiptPdf(tx) {
  return new Promise((resolve, reject) => {
    try {
      const safeRef  = String(tx.transaction_ref || tx.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_')
      const fileName = `receipt_${safeRef}.pdf`
      const filePath = path.join(RECEIPT_PDF_DIR, fileName)

      const doc = new PDFDocument({ size: 'A4', margin: 50 })
      const stream = fs.createWriteStream(filePath)
      doc.pipe(stream)

      const pageWidth   = doc.page.width
      const contentLeft = doc.page.margins.left
      const contentW    = pageWidth - doc.page.margins.left - doc.page.margins.right

      // ── Letterhead ────────────────────────────────────────────────
      const headerTop = doc.y
      if (fs.existsSync(LOGO_PATH)) {
        try { doc.image(LOGO_PATH, contentLeft, headerTop, { height: 46 }) } catch { /* ignore bad image */ }
      }
      doc
        .fillColor('#0f172a')
        .fontSize(15).font('Helvetica-Bold')
        .text('ENGINEERS REGISTRATION BOARD', contentLeft + 60, headerTop + 2, { width: contentW - 60 })
        .fontSize(9).font('Helvetica').fillColor('#64748b')
        .text('Plot 7, Nkrumah Road, Kampala, Uganda  ·  www.erb.go.ug', contentLeft + 60, headerTop + 22, { width: contentW - 60 })

      doc.moveDown(2.5)
      doc.moveTo(contentLeft, doc.y).lineTo(contentLeft + contentW, doc.y).strokeColor('#b30000').lineWidth(2).stroke()
      doc.moveDown(1)

      // ── Title ─────────────────────────────────────────────────────
      doc.fillColor('#b30000').fontSize(18).font('Helvetica-Bold')
        .text('OFFICIAL PAYMENT RECEIPT', { align: 'center' })
      doc.moveDown(0.3)
      doc.fillColor('#64748b').fontSize(10).font('Helvetica')
        .text(PURPOSE_LABEL[tx.purpose] || 'ERB Payment', { align: 'center' })
      doc.moveDown(1.5)

      // ── Summary strip: ref + amount ─────────────────────────────
      const stripTop = doc.y
      const stripH   = 54
      doc.roundedRect(contentLeft, stripTop, contentW, stripH, 6).fillAndStroke('#f8fafc', '#e2e8f0')
      const colW = contentW / 2
      doc.fillColor('#94a3b8').fontSize(8).font('Helvetica-Bold')
        .text('TRANSACTION REFERENCE', contentLeft + 16, stripTop + 10, { width: colW - 32 })
      doc.fillColor('#0f172a').fontSize(13).font('Helvetica-Bold')
        .text(tx.transaction_ref || '-', contentLeft + 16, stripTop + 24, { width: colW - 32 })

      doc.fillColor('#94a3b8').fontSize(8).font('Helvetica-Bold')
        .text('AMOUNT PAID', contentLeft + colW, stripTop + 10, { width: colW - 16, align: 'right' })
      doc.fillColor('#15803d').fontSize(15).font('Helvetica-Bold')
        .text(fmtUGX(tx.amount), contentLeft + colW, stripTop + 22, { width: colW - 16, align: 'right' })

      doc.y = stripTop + stripH + 24

      // ── Details table ────────────────────────────────────────────
      const rows = [
        ['Applicant Name',        tx.applicant_name || '-'],
        ['Registration Number',   tx.registration_number || tx.application_id || '-'],
        ['Payment Method',        tx.payment_method === 'MOBILE' ? `Mobile Money (${tx.provider || '-'})` : (tx.payment_method || tx.provider || '-')],
        ['Phone Number',          tx.phone || '-'],
        ['Payment Status',        'SUCCESS'],
        ['Date & Time',           fmtDate(tx.updatedAt || tx.createdAt)],
      ]

      doc.font('Helvetica').fontSize(11)
      for (const [label, value] of rows) {
        const rowY = doc.y
        doc.fillColor('#64748b').font('Helvetica').fontSize(10.5)
          .text(label, contentLeft, rowY, { width: contentW * 0.4 })
        doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10.5)
          .text(String(value), contentLeft + contentW * 0.4, rowY, { width: contentW * 0.6 })
        doc.moveDown(0.3)
        doc.moveTo(contentLeft, doc.y).lineTo(contentLeft + contentW, doc.y).strokeColor('#f1f5f9').lineWidth(1).stroke()
        doc.moveDown(0.5)
      }

      doc.moveDown(1.5)
      doc.fillColor('#334155').fontSize(9.5).font('Helvetica')
        .text(
          'This receipt confirms that the above payment has been successfully received by the ' +
          'Engineers Registration Board. Please retain this document for your records; it may be ' +
          'requested as proof of payment during your application review.',
          contentLeft, doc.y, { width: contentW, align: 'left', lineGap: 2 }
        )

      // ── Footer ────────────────────────────────────────────────────
      const footerY = doc.page.height - doc.page.margins.bottom - 30
      doc.moveTo(contentLeft, footerY).lineTo(contentLeft + contentW, footerY).strokeColor('#e2e8f0').lineWidth(1).stroke()
      doc.fillColor('#94a3b8').fontSize(8).font('Helvetica')
        .text(`Generated electronically on ${fmtDate(Date.now())}. This is a system-generated receipt and does not require a signature.`,
          contentLeft, footerY + 8, { width: contentW, align: 'center' })

      doc.end()

      stream.on('finish', () => resolve(filePath))
      stream.on('error', reject)
    } catch (err) {
      reject(err)
    }
  })
}
