const { pool } = require("../db-base");
require("dotenv").config();

async function setupTestPlan() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Update Existing Basic Plan (ID 2) Monthly price to ₹10
    console.log("Updating Basic plan (ID 2) monthly price to ₹10...");
    await client.query(
      "UPDATE plans SET price_monthly = 10 WHERE id = 2"
    );

    // 2. Add Test Plan (ID 4) with same features as Basic
    console.log("Adding Test Plan (ID 4)...");
    const basicPlanResult = await client.query("SELECT * FROM plans WHERE id = 2");
    if (basicPlanResult.rows.length === 0) {
      throw new Error("Basic plan (ID 2) not found in DB.");
    }
    const basic = basicPlanResult.rows[0];

    const result = await client.query(
      `INSERT INTO plans 
        (id, name, employee_limit, max_inventory_items, max_material_requests, messages_history_days, features, price_monthly, price_yearly)
      VALUES 
        ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        price_monthly = EXCLUDED.price_monthly,
        features = EXCLUDED.features`,
      [
        4, 
        'Basic Test Plan', 
        basic.employee_limit, 
        basic.max_inventory_items, 
        basic.max_material_requests, 
        basic.messages_history_days,
        basic.features,
        10,
        100 // small yearly just in case
      ]
    );

    await client.query("COMMIT");
    console.log("Done! Plans updated successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error setting up test plan:", err);
  } finally {
    client.release();
    process.exit();
  }
}

setupTestPlan();
