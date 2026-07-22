const BasePlugin = require("./base.plugin");
const EmployeeService = require("../../services/employeeService");

class EmployeePlugin extends BasePlugin {
  constructor() {
    super("EmployeePlugin", "Employees");

    // Tool: get_employees
    this.tools["get_employees"] = {
      name: "get_employees",
      description: "Retrieves list of employees for the company, with optional department/status filtering.",
      allowedRoles: ["owner", "hr", "admin", "employee"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {
          department: { type: "string", description: "Filter by department (e.g. Engineering, Sales, Field Support)" },
          status: { type: "string", description: "Filter by status: 'active' or 'inactive'" },
        },
      },
      execute: async (params, context) => {
        return await EmployeeService.getEmployees({
          companyId: context.user.companyId,
          department: params.department,
          status: params.status,
        });
      },
    };

    // Tool: create_employee
    this.tools["create_employee"] = {
      name: "create_employee",
      description: "Creates a new employee profile in SmartERP.",
      allowedRoles: ["owner", "hr", "admin"],
      isDestructive: true,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Full name of employee" },
          email: { type: "string", description: "Email address" },
          position: { type: "string", description: "Job title / position" },
          department: { type: "string", description: "Department name" },
        },
        required: ["name", "email"],
      },
      execute: async (params, context) => {
        return await EmployeeService.createEmployee({
          companyId: context.user.companyId,
          name: params.name,
          email: params.email,
          position: params.position,
          department: params.department,
        });
      },
    };

    // Skill: analyze_employee_performance
    this.skills["analyze_employee_performance"] = {
      name: "analyze_employee_performance",
      description: "Cross-module skill that analyzes top performing employees based on rating and active roles.",
      allowedRoles: ["owner", "hr", "admin"],
      execute: async (params, context) => {
        return await EmployeeService.getTopPerformers({
          companyId: context.user.companyId,
        });
      },
    };
  }
}

module.exports = EmployeePlugin;
