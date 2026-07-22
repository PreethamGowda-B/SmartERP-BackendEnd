const BasePlugin = require("./base.plugin");
const JobService = require("../../services/jobService");

class JobsPlugin extends BasePlugin {
  constructor() {
    super("JobsPlugin", "Jobs");

    // Tool: get_jobs
    this.tools["get_jobs"] = {
      name: "get_jobs",
      description: "Retrieves company jobs with optional status filter ('completed', 'in_progress', 'pending', 'open').",
      allowedRoles: ["owner", "hr", "admin", "employee"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by job status: 'completed', 'in_progress', 'pending', 'open'" },
          limit: { type: "number", description: "Max records to return (default 20)" },
        },
      },
      execute: async (params, context) => {
        return await JobService.getJobs({
          companyId: context.user.companyId,
          status: params.status,
          limit: params.limit,
        });
      },
    };

    // Tool: get_delayed_jobs
    this.tools["get_delayed_jobs"] = {
      name: "get_delayed_jobs",
      description: "Identifies overdue or delayed jobs that are not yet completed.",
      allowedRoles: ["owner", "hr", "admin", "employee"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (params, context) => {
        return await JobService.getDelayedJobs({
          companyId: context.user.companyId,
        });
      },
    };

    // Tool: create_job
    this.tools["create_job"] = {
      name: "create_job",
      description: "Creates a new job in SmartERP.",
      allowedRoles: ["owner", "hr", "admin"],
      isDestructive: true,
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Job title / title of task" },
          description: { type: "string", description: "Detailed description" },
          priority: { type: "string", description: "Priority: 'low', 'medium', 'high', 'urgent'" },
        },
        required: ["title"],
      },
      execute: async (params, context) => {
        return await JobService.createJob({
          companyId: context.user.companyId,
          title: params.title,
          description: params.description,
          priority: params.priority,
        });
      },
    };
  }
}

module.exports = JobsPlugin;
