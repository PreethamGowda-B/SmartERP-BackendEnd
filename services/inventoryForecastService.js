const { pool } = require('../db');
const ProviderFactory = require('../ai/providers/provider.factory');
const redisClient = require('../utils/redis');

class InventoryForecastService {
  /**
   * Deterministic Economic Order Quantity (EOQ) Formula.
   * EOQ = sqrt((2 * Demand * OrderCost) / HoldingCost)
   */
  static calculateEOQ({ annualDemand, orderCost = 500, annualHoldingCostPerUnit = 50 }) {
    if (!annualDemand || annualDemand <= 0) return 10;
    const eoq = Math.sqrt((2 * annualDemand * orderCost) / annualHoldingCostPerUnit);
    return Math.ceil(eoq);
  }

  /**
   * Deterministic Reorder Point (ROP) & Safety Stock Formula.
   * ROP = (Daily Usage Rate * Lead Time Days) + Safety Stock
   */
  static calculateROP({ dailyUsageRate, leadTimeDays = 7, serviceLevelFactor = 1.65 }) {
    const dailyRate = Math.max(0, parseFloat(dailyUsageRate || 0));
    // Standard deviation estimated as 20% of daily rate
    const stdDev = dailyRate * 0.20;
    const safetyStock = Math.ceil(serviceLevelFactor * stdDev * Math.sqrt(leadTimeDays));
    const rop = Math.ceil(dailyRate * leadTimeDays + safetyStock);

    return {
      dailyUsageRate: dailyRate,
      safetyStock,
      reorderPoint: rop,
    };
  }

  /**
   * Recalculates demand forecasts and ROP for all inventory items of a company.
   */
  static async recalculateCompanyForecasts(companyId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_company_id', $1::text, true)`, [String(companyId)]);

      // 1. Fetch inventory items with current quantities
      const itemsRes = await client.query(
        `SELECT id, name, quantity, min_quantity FROM inventory_items WHERE company_id = $1`,
        [companyId]
      );

      const updatedForecasts = [];

      for (const item of itemsRes.rows) {
        // Estimate daily usage rate based on min_quantity or historical velocity
        const dailyRate = Math.max(0.5, parseFloat(item.min_quantity || 1) / 10.0);
        const annualDemand = dailyRate * 365;

        const ropResult = this.calculateROP({ dailyUsageRate: dailyRate, leadTimeDays: 7 });
        const eoqQuantity = this.calculateEOQ({ annualDemand });
        const predicted30dDemand = Math.ceil(dailyRate * 30);
        const currentQty = parseFloat(item.quantity || 0);
        const isRopBreached = currentQty <= ropResult.reorderPoint;

        // Upsert into inventory_forecasts table
        const forecastRes = await client.query(
          `INSERT INTO inventory_forecasts
           (company_id, item_id, daily_usage_rate, safety_stock, reorder_point, economic_order_quantity, predicted_30d_demand, is_rop_breached, last_calculated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
           ON CONFLICT (company_id, item_id)
           DO UPDATE SET
             daily_usage_rate = EXCLUDED.daily_usage_rate,
             safety_stock = EXCLUDED.safety_stock,
             reorder_point = EXCLUDED.reorder_point,
             economic_order_quantity = EXCLUDED.economic_order_quantity,
             predicted_30d_demand = EXCLUDED.predicted_30d_demand,
             is_rop_breached = EXCLUDED.is_rop_breached,
             last_calculated_at = NOW()
           RETURNING *`,
          [companyId, item.id, ropResult.dailyUsageRate, ropResult.safetyStock, ropResult.reorderPoint, eoqQuantity, predicted30dDemand, isRopBreached]
        );

        updatedForecasts.push(forecastRes.rows[0]);
      }

      await client.query('COMMIT');
      return updatedForecasts;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Generates an Agentic Draft Purchase Order for ROP-breached items.
   */
  static async generateAgenticDraftPO({ companyId, userId, supplierId, itemsToReorder = [] }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_company_id', $1::text, true)`, [String(companyId)]);

      const poNumber = `PO-${Date.now().toString().slice(-6)}`;

      // Generate AI Reasoning via Groq LLM
      let aiReasoning = 'Automated ROP breach trigger: Stock levels breached minimum safety thresholds.';
      try {
        const provider = ProviderFactory.getProvider();
        const completion = await provider.generateCompletion({
          messages: [
            {
              role: 'user',
              content: `Generate a 1-sentence executive reasoning summary for creating a Purchase Order for ${itemsToReorder.length} low-stock inventory items.`,
            },
          ],
          temperature: 0.2,
        });
        if (completion.content) aiReasoning = completion.content.trim();
      } catch (e) {
        // Fallback reasoning if LLM fails
      }

      let totalPoAmount = 0;

      // Create PO Header
      const poRes = await client.query(
        `INSERT INTO inventory_purchase_orders
         (company_id, supplier_id, created_by, po_number, status, total_amount, is_ai_generated, ai_generation_reasoning, expected_delivery_date)
         VALUES ($1, $2, $3, $4, 'draft', 0.00, TRUE, $5, NOW() + INTERVAL '7 days')
         RETURNING *`,
        [companyId, supplierId, userId, poNumber, aiReasoning]
      );

      const poId = poRes.rows[0].id;

      // Insert Line Items
      for (const item of itemsToReorder) {
        const qty = parseFloat(item.quantity || 10);
        const price = parseFloat(item.unitPrice || 100);
        const lineTotal = qty * price;
        totalPoAmount += lineTotal;

        await client.query(
          `INSERT INTO inventory_po_items (po_id, company_id, item_id, quantity_ordered, unit_price, total_price)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [poId, companyId, item.itemId, qty, price, lineTotal]
        );
      }

      // Update Header Total Amount
      await client.query(`UPDATE inventory_purchase_orders SET total_amount = $1 WHERE id = $2`, [totalPoAmount, poId]);

      await client.query('COMMIT');
      return { success: true, poId, poNumber, totalAmount: totalPoAmount, status: 'draft' };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = InventoryForecastService;
