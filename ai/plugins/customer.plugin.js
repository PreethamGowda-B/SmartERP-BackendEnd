const BasePlugin = require("./base.plugin");
const CustomerService = require("../../services/customerService");

class CustomerPlugin extends BasePlugin {
  constructor() {
    super("CustomerPlugin", "Customers");

    // Tool: get_customers
    this.tools["get_customers"] = {
      name: "get_customers",
      description: "Retrieves customer directory and profiles for the company.",
      allowedRoles: ["owner", "hr", "admin", "employee"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {
          search: { type: "string", description: "Search keyword for customer name, company, or email" },
        },
      },
      execute: async (params, context) => {
        return await CustomerService.getCustomers({
          companyId: context.user.companyId,
          search: params.search,
        });
      },
    };

    // Tool: create_customer
    this.tools["create_customer"] = {
      name: "create_customer",
      description: "Creates a new customer profile.",
      allowedRoles: ["owner", "hr", "admin"],
      isDestructive: true,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Customer contact name" },
          email: { type: "string", description: "Customer email" },
          phone: { type: "string", description: "Phone number" },
          companyName: { type: "string", description: "Customer company name" },
        },
        required: ["name"],
      },
      execute: async (params, context) => {
        return await CustomerService.createCustomer({
          companyId: context.user.companyId,
          name: params.name,
          email: params.email,
          phone: params.phone,
          companyName: params.companyName,
        });
      },
    };
  }
}

module.exports = CustomerPlugin;
