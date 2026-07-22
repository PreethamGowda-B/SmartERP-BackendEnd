const BasePlugin = require("./base.plugin");

class NavigationPlugin extends BasePlugin {
  constructor() {
    super("NavigationPlugin", "Navigation");

    // Tool: navigate_to_route
    this.tools["navigate_to_route"] = {
      name: "navigate_to_route",
      description: "Directs the Next.js frontend application to automatically open a specified page route.",
      allowedRoles: ["owner", "hr", "admin", "employee"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {
          targetPage: {
            type: "string",
            description: "Target module/page to navigate to. Allowed: 'payroll', 'employees', 'inventory', 'jobs', 'attendance', 'reports', 'settings', 'messages'",
          },
        },
        required: ["targetPage"],
      },
      execute: async (params, context) => {
        const role = context.user.role || "employee";
        const page = params.targetPage.toLowerCase().trim();

        let prefix = "/employee";
        if (role === "owner" || role === "admin") {
          prefix = "/owner";
        } else if (role === "hr") {
          prefix = "/hr";
        }

        const routeMap = {
          payroll: `${prefix}/payroll`,
          employees: `${prefix}/employees`,
          inventory: `${prefix}/materials`, // materials & inventory route
          jobs: `${prefix}/jobs`,
          attendance: `${prefix}/attendance`,
          reports: `${prefix}/reports`,
          settings: `${prefix}/settings`,
          messages: `${prefix}/messages`,
          dashboard: prefix,
        };

        const targetRoute = routeMap[page] || `${prefix}/${page}`;

        return {
          action: "NAVIGATE",
          path: targetRoute,
          label: `Opening ${params.targetPage} module...`,
        };
      },
    };
  }
}

module.exports = NavigationPlugin;
