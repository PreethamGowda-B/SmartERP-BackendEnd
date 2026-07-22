const { pool } = require("../db");

class AttendanceService {
  /**
   * Retrieves today's attendance summary.
   */
  static async getTodayAttendance({ companyId }) {
    if (!companyId) throw new Error("Company ID is required.");
    const todayStr = new Date().toISOString().split("T")[0];

    const attendanceRes = await pool.query(
      `SELECT a.user_id, u.name, u.email, a.status, a.clock_in, a.clock_out
       FROM attendance a
       JOIN users u ON a.user_id = u.id
       WHERE a.company_id::text = $1 AND (a.date = $2 OR a.created_at::date = $2::date)`,
      [String(companyId), todayStr]
    );

    const totalRes = await pool.query(
      `SELECT COUNT(*) as total FROM users WHERE company_id::text = $1 AND is_active = true`,
      [String(companyId)]
    );

    const totalActive = parseInt(totalRes.rows[0]?.total || 0);
    const presentCount = attendanceRes.rows.filter((r) => r.status === "present" || r.status === "late").length;
    const absentCount = Math.max(0, totalActive - presentCount);

    return {
      date: todayStr,
      totalEmployees: totalActive,
      presentCount,
      absentCount,
      records: attendanceRes.rows,
    };
  }

  /**
   * Analyzes absenteeism risk over recent records.
   */
  static async getAbsenteeismRisk({ companyId }) {
    if (!companyId) throw new Error("Company ID is required.");

    const res = await pool.query(
      `SELECT u.name, u.email, COUNT(a.id) as attendance_records
       FROM users u
       LEFT JOIN attendance a ON u.id = a.user_id AND a.status = 'present'
       WHERE u.company_id::text = $1 AND u.is_active = true
       GROUP BY u.id, u.name, u.email
       ORDER BY attendance_records ASC LIMIT 5`,
      [String(companyId)]
    );

    return {
      riskSummary: "Absenteeism risk assessment based on recent clock-in activity.",
      atRiskEmployees: res.rows,
    };
  }
}

module.exports = AttendanceService;
