const { pool } = require("../db");

class AttendanceService {
  /**
   * Retrieves today's attendance summary matching canonical owner overview logic.
   */
  static async getTodayAttendance({ companyId }) {
    if (!companyId) throw new Error("Company ID is required.");
    const cid = String(companyId);
    const todayStr = new Date().toISOString().split("T")[0];

    const result = await pool.query(
      `SELECT 
         u.id as user_id,
         u.name as employee_name,
         u.email as employee_email,
         a.id as attendance_id,
         a.date,
         a.check_in_time,
         a.check_out_time,
         a.working_hours,
         a.status,
         a.is_late
       FROM users u
       LEFT JOIN attendance a ON u.id = a.user_id AND (a.date = CURRENT_DATE OR a.date::text = CURRENT_DATE::text)
       WHERE (u.role = 'employee' OR (u.role != 'owner' AND u.role != 'admin' AND u.role != 'customer'))
         AND (u.company_id = $1 OR u.company_id::text = $1::text)
       ORDER BY u.name ASC`,
      [cid]
    ).catch((err) => {
      console.error("❌ AttendanceService.getTodayAttendance error:", err.message);
      return { rows: [] };
    });

    const rows = result.rows || [];
    const totalEmployees = rows.length;
    const presentCount = rows.filter(
      (r) => r.check_in_time || ["present", "late", "half_day"].includes(r.status)
    ).length;
    const absentCount = rows.filter(
      (r) => !r.check_in_time && !["present", "late", "half_day"].includes(r.status)
    ).length;
    const lateCount = rows.filter((r) => r.is_late || r.status === "late").length;

    return {
      date: todayStr,
      totalEmployees,
      presentCount,
      absentCount,
      lateCount,
      records: rows.map((r) => ({
        ...r,
        name: r.employee_name,
        email: r.employee_email,
        clock_in: r.check_in_time,
        clock_out: r.check_out_time,
      })),
    };
  }

  /**
   * Analyzes absenteeism risk over recent records.
   */
  static async getAbsenteeismRisk({ companyId }) {
    if (!companyId) throw new Error("Company ID is required.");
    const cid = String(companyId);

    const res = await pool.query(
      `SELECT u.name, u.email, COUNT(a.id) as attendance_records
       FROM users u
       LEFT JOIN attendance a ON u.id = a.user_id AND (a.check_in_time IS NOT NULL OR a.status IN ('present', 'late', 'half_day'))
       WHERE (u.company_id = $1 OR u.company_id::text = $1::text)
         AND (u.role = 'employee' OR (u.role != 'owner' AND u.role != 'admin' AND u.role != 'customer'))
       GROUP BY u.id, u.name, u.email
       ORDER BY attendance_records ASC LIMIT 5`,
      [cid]
    ).catch((err) => {
      console.error("❌ AttendanceService.getAbsenteeismRisk error:", err.message);
      return { rows: [] };
    });

    return {
      riskSummary: "Absenteeism risk assessment based on recent clock-in activity.",
      atRiskEmployees: res.rows || [],
    };
  }
}

module.exports = AttendanceService;
