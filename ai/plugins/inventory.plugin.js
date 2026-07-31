const BasePlugin = require("./base.plugin");
const InventoryService = require("../../services/inventoryService");
const InventoryForecastService = require("../../services/inventoryForecastService");

class InventoryPlugin extends BasePlugin {
  constructor() {
    super("InventoryPlugin", "Provides tools for inventory management, ROP forecasts, and low stock tracking.");

    // Tool: get_low_stock_items
    this.tools["get_low_stock_items"] = {
      name: "get_low_stock_items",
      description: "Retrieves inventory items running low or below minimum threshold.",
      allowedRoles: ["owner", "hr", "admin", "employee"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (params, context) => {
        return await InventoryService.getLowStockItems({
          companyId: context.user.companyId,
        });
      },
    };

    // Tool: get_material_requests
    this.tools["get_material_requests"] = {
      name: "get_material_requests",
      description: "Retrieves material and inventory reorder requests for the company.",
      allowedRoles: ["owner", "hr", "admin", "employee"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter status: 'pending', 'approved', 'rejected'" },
        },
      },
      execute: async (params, context) => {
        return await InventoryService.getMaterialRequests({
          companyId: context.user.companyId,
          status: params.status,
        });
      },
    };

    // Tool: get_demand_forecasts
    this.tools["get_demand_forecasts"] = {
      name: "get_demand_forecasts",
      description: "Retrieves AI demand forecasts, dynamic Reorder Points (ROP), and EOQ estimates for company items.",
      allowedRoles: ["owner", "admin", "hr"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (params, context) => {
        const forecasts = await InventoryForecastService.recalculateCompanyForecasts(context.user.companyId);
        return { success: true, count: forecasts.length, forecasts };
      },
    };
  }
}

module.exports = InventoryPlugin;
