const BasePlugin = require("./base.plugin");
const { pool } = require("../../db");

class AttendancePlugin extends BasePlugin {
  constructor() {
    super("AttendancePlugin", "Attendance");

    // Tool: get_today_attendance
    this.tools["get_today_attendance"] = {
      name: "get_today_attendance",
      description: "Retrieves today's attendance metrics including present count, absent list, and clock-in logs.",
      allowedRoles: ["owner", "hr", "admin", "employee"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (params, context) => {
        const companyId = context.user.companyId;
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
      },
    };

    // Skill: assess_absenteeism_risk
    this.skills["assess_absenteeism_risk"] = {
      name: "assess_absenteeism_risk",
      description: "Analyzes attendance trend over the past 30 days to highlight absenteeism risks.",
      allowedRoles: ["owner", "hr", "admin"],
      execute: async (params, context) => {
        const companyId = context.user.companyId;
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
          riskSummary: "Employees with lowest recorded attendance activity in recent records.",
          atRiskEmployees: res.rows,
        };
      },
    };
  }
}

module.exports = AttendancePlugin;
