const { pool } = require("../db");
const { broadcastToUser } = require("../utils/notificationHelpers");

/**
 * Event-Driven Auto-Messaging Helper Service
 * Automatically sends contextual messages & interactive ERP cards across portals
 */
class EventMessagingService {
  /**
   * Spawns/Fetches job conversation and sends introductory job card
   */
  static async onJobCreated({ jobId, companyId, title, customerId, ownerId, assignedEmployeeId }) {
    try {
      // 1. Create or get job conversation
      const convRes = await pool.query(
        `INSERT INTO conversations (company_id, conversation_type, job_id)
         VALUES ($1, 'job', $2)
         RETURNING id`,
        [companyId, String(jobId)]
      );
      const convId = convRes.rows[0].id;

      // 2. Add participants (Customer, Owner, Assigned Employee)
      const participants = new Set([String(ownerId)]);
      if (customerId) participants.add(String(customerId));
      if (assignedEmployeeId) participants.add(String(assignedEmployeeId));

      for (const uid of participants) {
        if (uid && uid !== "null" && uid !== "undefined") {
          await pool.query(
            `INSERT INTO conversation_participants (conversation_id, user_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [convId, uid]
          );
        }
      }

      // 3. Insert initial Job ERP Card Message
      await pool.query(
        `INSERT INTO messages 
         (conversation_id, sender_id, message, content, message_type, erp_record_type, erp_record_id, created_at)
         VALUES ($1, $2::uuid, $3, $3, 'erp_card', 'job', $4, NOW())`,
        [convId, String(ownerId), `📋 Job Created: ${title}`, String(jobId)]
      );

      return convId;
    } catch (err) {
      console.warn("⚠️ EventMessagingService.onJobCreated skipped:", err.message);
    }
  }

  /**
   * Posts proof photo to job conversation thread
   */
  static async onProofUploaded({ jobId, companyId, photoUrl, notes, technicianName, senderId }) {
    try {
      const convRes = await pool.query(
        `SELECT id FROM conversations WHERE job_id = $1 AND company_id = $2 LIMIT 1`,
        [String(jobId), companyId]
      );
      if (convRes.rows.length > 0) {
        const convId = convRes.rows[0].id;
        await pool.query(
          `INSERT INTO messages 
           (conversation_id, sender_id, message, content, media_url, media_type, created_at)
           VALUES ($1, $2::uuid, $3, $3, $4, 'image', NOW())`,
          [convId, String(senderId || "00000000-0000-0000-0000-000000000000"), `📸 Site Proof Uploaded by ${technicianName}: ${notes || ''}`, photoUrl]
        );
      }
    } catch (err) {
      console.warn("⚠️ EventMessagingService.onProofUploaded skipped:", err.message);
    }
  }

  /**
   * Posts invoice card to job conversation thread
   */
  static async onInvoiceIssued({ jobId, companyId, invoiceNumber, totalAmount, senderId }) {
    try {
      const convRes = await pool.query(
        `SELECT id FROM conversations WHERE job_id = $1 AND company_id = $2 LIMIT 1`,
        [String(jobId), companyId]
      );
      if (convRes.rows.length > 0) {
        const convId = convRes.rows[0].id;
        await pool.query(
          `INSERT INTO messages 
           (conversation_id, sender_id, message, content, message_type, erp_record_type, erp_record_id, created_at)
           VALUES ($1, $2::uuid, $3, $3, 'erp_card', 'invoice', $4, NOW())`,
          [convId, String(senderId || "00000000-0000-0000-0000-000000000000"), `🧾 Invoice ${invoiceNumber} issued for ₹${Number(totalAmount).toLocaleString('en-IN')}`, String(invoiceNumber)]
        );
      }
    } catch (err) {
      console.warn("⚠️ EventMessagingService.onInvoiceIssued skipped:", err.message);
    }
  }
}

module.exports = EventMessagingService;
