const BasePlugin = require("./base.plugin");
const AttendanceService = require("../../services/attendanceService");

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
        return await AttendanceService.getTodayAttendance({
          companyId: context.user.companyId,
        });
      },
    };

    // Skill: assess_absenteeism_risk
    this.skills["assess_absenteeism_risk"] = {
      name: "assess_absenteeism_risk",
      description: "Analyzes attendance trend over recent records to highlight absenteeism risks.",
      allowedRoles: ["owner", "hr", "admin"],
      execute: async (params, context) => {
        return await AttendanceService.getAbsenteeismRisk({
          companyId: context.user.companyId,
        });
      },
    };
  }
}

module.exports = AttendancePlugin;
