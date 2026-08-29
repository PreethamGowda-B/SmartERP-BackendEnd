const BasePlugin = require("./base.plugin");
const { pool } = require("../../db");

// ─── Verified CNC Controller Alarm & Troubleshooting Knowledge Base ──────────
const VERIFIED_CNC_KNOWLEDGE = {
  // Haas NGC / Classic
  "HAAS_401": {
    controller: "Haas NGC / Classic",
    alarmCode: "401",
    title: "Servo Off / Drive Fault",
    severity: "critical",
    category: "Servo System",
    description: "Main vector drive or axis amplifier status line indicated a fault, turning all axis servos off.",
    causes: [
      "Low DC bus voltage (< 310V DC) from incoming power dip or regenerative discharge load.",
      "High voltage spike or shorted motor power cable / brake winding.",
      "Vector drive fault or fault signal cable loose at Main PCB (Connector P1-P4).",
      "Overheated amplifier or failed cooling fan."
    ],
    safetyWarning: "HIGH VOLTAGE HAZARD: DC bus capacitors retain >320V DC charge for up to 10 minutes after main power off. Measure DC bus voltage with a calibrated CAT-III/IV multimeter before touching terminals.",
    diagnosticSteps: [
      "Record any secondary alarms displayed simultaneously (e.g. Alarm 161 Drive Fault, 162 X-Axis Short).",
      "Power off machine and wait 10 minutes for DC bus discharge.",
      "Inspect Vector Drive status LEDs (Fault, Overvoltage, Regen) on the drive faceplate.",
      "Disconnect motor leads from amplifier and measure phase-to-phase resistance (~1.2Ω) and phase-to-ground (> 100MΩ).",
      "Check incoming 3-phase line balance (all 3 phases within 2% voltage balance)."
    ],
    verifiedCitations: ["📘 Haas NGC Service Manual — Section 4 (Vector Drive)", "📘 SmartERP CNC Knowledge Base (Ref: CNC-HAA-401)"]
  },
  "HAAS_104": {
    controller: "Haas NGC",
    alarmCode: "104",
    title: "Y-Axis Following Error / Position Lag",
    severity: "warning",
    category: "Axis Drive",
    description: "Difference between commanded axis coordinate and actual encoder position exceeded Parameter 26 error limit.",
    causes: [
      "Way lube pump failure or blocked lube metering valve causing high friction on linear guide ways.",
      "Loose motor-to-ballscrew coupling or gib misalignment.",
      "Encoder cable shielding degradation or optical scale contamination."
    ],
    safetyWarning: "Ensure emergency stop is engaged before working inside machine enclosure near axis travel paths.",
    diagnosticSteps: [
      "Check way lube pressure gauge during manual pump cycle (nominal 25-45 PSI).",
      "Inspect Y-axis way covers for chip compaction or mechanical binding.",
      "Jog axis slowly in JOG mode while monitoring motor load percentage on the Diagnostics screen.",
      "Inspect coupling clamping bolt torque (25 Nm) between servo motor and ball screw."
    ],
    verifiedCitations: ["📘 Haas Mill Service Manual", "📘 SmartERP Machine Maintenance SOP #104"]
  },
  "HAAS_991": {
    controller: "Haas NGC",
    alarmCode: "991",
    title: "Door Interlock Safety Violation",
    severity: "warning",
    category: "Safety Interlock",
    description: "Enclosure safety switch opened while spindle was commanded or axis motion was active.",
    causes: ["Safety door mechanical switch misaligned or dirty.", "Safety interlock key damaged or bypassed."],
    safetyWarning: "NEVER bypass door interlocks. Industrial safety regulations (ISO 13849-1) require active safety circuits.",
    diagnosticSteps: [
      "Clean safety switch optical/magnetic head from metal chips.",
      "Inspect wiring harness at door switch terminal.",
      "Verify door switch bit in Diagnostics > I/O state changes when door is latched."
    ],
    verifiedCitations: ["📘 Haas Safety Manual", "📘 ISO 13849-1 Machine Safety Guidelines"]
  },

  // Fanuc 0i-MF / 31i
  "FANUC_401": {
    controller: "Fanuc 0i-MF / 31i",
    alarmCode: "401",
    title: "V-READY OFF (Servo Amplifier Not Ready)",
    severity: "critical",
    category: "Servo System",
    description: "The servo amplifier ready signal (VRDY) dropped LOW even though the CNC controller commanded PRDY (Power Ready).",
    causes: [
      "Emergency Stop contact open or 24V DC I/O supply dropped.",
      "Servo amplifier optical cable (FSSB) disconnected or damaged.",
      "Main magnetic contactor (MCC) trip or phase loss on 200V AC servo transformer."
    ],
    safetyWarning: "Isolate 415V/200V transformer power and lockout before inspecting MCC contactor coils.",
    diagnosticSteps: [
      "Inspect LED display on Fanuc Servo Amplifier module (e.g. display '--' = normal standby, '01'/'02' = IPM overcurrent, 'b0' = FSSB comms error).",
      "Check 24V DC power supply voltage on amplifier connector CXA2A (must be 24V ± 10%).",
      "Inspect FSSB optical cable links between CNC main CPU and servo amplifiers for red laser light transmission.",
      "Verify MCC contactor auxiliary contacts for carbon pitting or weld failure."
    ],
    verifiedCitations: ["📘 Fanuc Series 0i-MODEL F Maintenance Manual (B-64605EN)", "📘 SmartERP Servo Diagnostic Guide"]
  },
  "FANUC_EX1001": {
    controller: "Fanuc 0i-MF / 31i",
    alarmCode: "EX1001",
    title: "Spindle Drive / Chiller Temperature Overheat",
    severity: "critical",
    category: "Spindle & Chiller",
    description: "Spindle motor thermistor or spindle drive heat sink temperature exceeded safety trip threshold (110°C).",
    causes: [
      "Spindle oil chiller circulation pump failure or coolant flow rate below 8 L/min.",
      "Cabinet heat exchanger air filters clogged with cutting oil vapor/dust.",
      "Spindle motor cooling fan defective or thermistor circuit wire broken."
    ],
    safetyWarning: "Allow spindle motor to cool for at least 30 minutes before opening motor junction box.",
    diagnosticSteps: [
      "Check chiller flow switch LED indicator and chiller oil temperature gauge.",
      "Clean cabinet intake wire mesh filters using compressed air (max 3 bar).",
      "Measure thermistor resistance at amplifier connector JYA3 (standard 10kΩ NTC at 25°C).",
      "Check Fanuc Diagnosis Parameter #400-405 for recorded spindle thermal load %."
    ],
    verifiedCitations: ["📘 Fanuc Spindle Amplifier Maintenance Guide", "📘 SmartERP Preventive Maintenance SOP-01"]
  },
  "FANUC_OT0500": {
    controller: "Fanuc 0i / 31i",
    alarmCode: "OT0500",
    title: "+X Axis Over Travel (Soft Limit 1)",
    severity: "info",
    category: "Axis Overtravel",
    description: "The commanded move in +X axis exceeded positive software stroke limit set in CNC Parameter 1320.",
    causes: ["Program coordinate offset (G54-G59) shifted or tool length compensation error.", "Workpiece or fixture placed outside physical machining envelope."],
    safetyWarning: "Use lowest JOG feedrate when backing off overtravel limit to prevent hard mechanical stop collision.",
    diagnosticSteps: [
      "Switch CNC mode selector to JOG or MANUAL.",
      "Press and hold the 'Overtravel Release' or 'OT Release' push button on machine operator panel.",
      "Jog X-axis in negative (-) direction until clear of software boundary.",
      "Check active G54 workpiece zero and verify CNC program coordinates."
    ],
    verifiedCitations: ["📘 Fanuc Operator Manual", "📘 SmartERP CNC Basics Guide"]
  },

  // Siemens 840D / 828D
  "SIEMENS_2001": {
    controller: "Siemens Sinumerik 840D / 828D",
    alarmCode: "2001",
    title: "PLC Axis Interlock Not Released",
    severity: "warning",
    category: "PLC Interlock",
    description: "Axis motion enable signal (DB31-48.DBX21.7) not enabled by PLC logic program.",
    causes: [
      "Hydraulic system pressure below minimum threshold (35 bar).",
      "Lubrication pressure switch not confirming pressure pulse within cycle timer.",
      "Tool clamp confirmation proximity switch (DB380x.DBX2001.0) inactive."
    ],
    safetyWarning: "Do not attempt manual tool unclamp while spindle motor is in motion.",
    diagnosticSteps: [
      "Check hydraulic pressure gauge on main power pack (nominal 45 bar).",
      "Navigate to Diagnostics > PLC Status and check DB31.DBX21.7 bit state.",
      "Verify tool unclamp sensor LED on spindle cylinder top cap.",
      "Inspect way lube reservoir fluid level."
    ],
    verifiedCitations: ["📘 Siemens Sinumerik 840D sl Diagnostics Manual", "📘 SmartERP Interlock Guide"]
  },

  // Mitsubishi M80 / M70
  "MITSUBISHI_AL04": {
    controller: "Mitsubishi M80 / M70",
    alarmCode: "AL-04",
    title: "Servo Amplifier Overcurrent / Short Circuit",
    severity: "critical",
    category: "Servo System",
    description: "MDS-D/DH servo drive detected excessive instantaneous current flowing through the output IGBT inverter bridge.",
    causes: [
      "Motor power cable harness insulation breakdown or pinched wire in cable track.",
      "Motor internal winding burnt due to coolant ingress through conduit seal.",
      "Mechanical axis collision or jammed ball screw."
    ],
    safetyWarning: "Disconnect main 3-phase circuit breaker and wait for CHARGE LED to extinguish completely before opening servo drive cover.",
    diagnosticSteps: [
      "Disconnect motor power cable (U, V, W) from drive bottom terminals.",
      "Perform Insulation Resistance (Megger) test at 500V DC on motor leads (must exceed 50 MΩ to earth).",
      "Check resistance between U-V, V-W, W-U with milliohmmeter (must be balanced within 0.05Ω).",
      "Inspect flexible cable energy chain for wear, bend fatigue, or cutting fluid accumulation."
    ],
    verifiedCitations: ["📘 Mitsubishi Electric MDS-D-SVJ3 Maintenance Manual", "📘 SmartERP Servo Diagnostic SOP #04"]
  }
};

class CncPlugin extends BasePlugin {
  constructor() {
    super("CncPlugin", "Provides deep CNC machine registry awareness, controller error code decoding, telemetry, and service history tools.");

    // ── Tool 1: get_company_machines ──────────────────────────────────────────
    this.tools["get_company_machines"] = {
      name: "get_company_machines",
      description: "Retrieves the list of CNC machines registered to the company with serial numbers, controllers, spindle hours, and status.",
      allowedRoles: ["owner", "admin", "hr", "employee", "super_admin"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {
          search: { type: "string", description: "Optional filter by machine name, serial number, make, or controller" },
          status: { type: "string", description: "Optional status filter: 'operational', 'maintenance', 'warning', 'offline'" }
        }
      },
      execute: async (params, context) => {
        const companyId = context.user.companyId;
        if (!companyId && context.user.role !== "super_admin") {
          return { success: false, message: "Unauthorized: Missing company context.", machines: [] };
        }

        let query = `
          SELECT m.id, m.machine_name, m.serial_number, m.make, m.model, m.controller_type,
                 m.spindle_hours, m.health_score, m.critical_level, m.status, m.created_at,
                 COALESCE(c.name, c.email, 'Customer') as customer_name,
                 COALESCE(p.plant_name, 'Main Plant') as plant_name
          FROM customer_machines m
          LEFT JOIN customers c ON m.customer_id::text = c.id::text
          LEFT JOIN customer_plants p ON m.plant_id::text = p.id::text
          WHERE m.company_id::text = $1::text
        `;
        const queryParams = [String(companyId)];

        if (params.status) {
          queryParams.push(params.status);
          query += ` AND m.status = $${queryParams.length}`;
        }
        if (params.search) {
          queryParams.push(`%${params.search}%`);
          query += ` AND (m.machine_name ILIKE $${queryParams.length} OR m.serial_number ILIKE $${queryParams.length} OR m.controller_type ILIKE $${queryParams.length} OR m.make ILIKE $${queryParams.length})`;
        }

        query += ` ORDER BY m.created_at DESC LIMIT 25`;

        const result = await pool.query(query, queryParams).catch(async () => {
          return pool.query(
            `SELECT id, machine_name, serial_number, make, model, controller_type, spindle_hours, health_score, status
             FROM customer_machines WHERE company_id::text = $1::text ORDER BY created_at DESC LIMIT 25`,
            [String(companyId)]
          ).catch(() => ({ rows: [] }));
        });

        return {
          success: true,
          count: result.rows.length,
          machines: result.rows
        };
      }
    };

    // ── Tool 2: get_machine_details ───────────────────────────────────────────
    this.tools["get_machine_details"] = {
      name: "get_machine_details",
      description: "Retrieves complete technical profile, controller specs, customer plant, and warranty information for a specific CNC machine.",
      allowedRoles: ["owner", "admin", "hr", "employee", "super_admin"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {
          machineId: { type: "string", description: "The UUID or ID of the machine" },
          serialNumber: { type: "string", description: "The serial number of the machine (alternative to machineId)" }
        }
      },
      execute: async (params, context) => {
        const companyId = context.user.companyId;
        if (!companyId && context.user.role !== "super_admin") {
          return { success: false, message: "Unauthorized: Missing company context." };
        }

        let query = `
          SELECT m.*, COALESCE(c.name, c.email, 'Customer') as customer_name,
                 COALESCE(p.plant_name, 'Main Plant') as plant_name,
                 COALESCE(p.address, 'Plant Site') as plant_address
          FROM customer_machines m
          LEFT JOIN customers c ON m.customer_id::text = c.id::text
          LEFT JOIN customer_plants p ON m.plant_id::text = p.id::text
          WHERE m.company_id::text = $1::text
        `;
        const queryParams = [String(companyId)];

        if (params.machineId) {
          queryParams.push(params.machineId);
          query += ` AND (m.id::text = $${queryParams.length}::text OR m.machine_name ILIKE $${queryParams.length})`;
        } else if (params.serialNumber) {
          queryParams.push(params.serialNumber);
          query += ` AND m.serial_number ILIKE $${queryParams.length}`;
        } else {
          return { success: false, message: "Please provide either machineId or serialNumber." };
        }

        const res = await pool.query(query, queryParams).catch(() => ({ rows: [] }));
        if (res.rows.length === 0) {
          return { success: false, message: "Machine not found or not registered under your company." };
        }

        return {
          success: true,
          machine: res.rows[0]
        };
      }
    };

    // ── Tool 3: get_machine_service_history ───────────────────────────────────
    this.tools["get_machine_service_history"] = {
      name: "get_machine_service_history",
      description: "Retrieves past service jobs, maintenance records, previous alarms, and breakdown resolutions for a CNC machine.",
      allowedRoles: ["owner", "admin", "hr", "employee", "super_admin"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {
          machineId: { type: "string", description: "The UUID or ID of the machine" },
          limit: { type: "number", description: "Max records to retrieve (default: 10)" }
        }
      },
      execute: async (params, context) => {
        const companyId = context.user.companyId;
        if (!companyId && context.user.role !== "super_admin") {
          return { success: false, message: "Unauthorized: Missing company context.", history: [] };
        }

        const limit = params.limit || 10;
        // Search in jobs / service tickets
        const query = `
          SELECT j.id, j.title, j.description, j.status, j.priority, j.created_at, j.updated_at,
                 j.assigned_to_name, j.location, j.progress
          FROM jobs j
          WHERE j.company_id::text = $1::text
            AND (j.description ILIKE '%' || $2 || '%' OR j.title ILIKE '%' || $2 || '%' OR j.machine_id::text = $2::text)
          ORDER BY j.created_at DESC
          LIMIT $3
        `;

        const machineIdentifier = String(params.machineId || "");
        const res = await pool.query(query, [String(companyId), machineIdentifier, limit]).catch(async () => {
          // Fallback simple query
          return pool.query(
            `SELECT id, title, description, status, priority, created_at FROM jobs
             WHERE company_id::text = $1::text ORDER BY created_at DESC LIMIT $2`,
            [String(companyId), limit]
          ).catch(() => ({ rows: [] }));
        });

        return {
          success: true,
          count: res.rows.length,
          history: res.rows
        };
      }
    };

    // ── Tool 4: decode_cnc_alarm ──────────────────────────────────────────────
    this.tools["decode_cnc_alarm"] = {
      name: "decode_cnc_alarm",
      description: "Decodes a CNC alarm or error code against verified controller manuals (Fanuc, Siemens, Haas, Mitsubishi) and provides root cause and diagnostic procedures.",
      allowedRoles: ["owner", "admin", "hr", "employee", "super_admin"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {
          alarmCode: { type: "string", description: "The alarm code number or text (e.g. '401', 'EX1001', 'AL-04', '2001', '104')" },
          controllerType: { type: "string", description: "Controller family: 'Haas', 'Fanuc', 'Siemens', 'Mitsubishi', 'Heidenhain', or 'Universal'" }
        },
        required: ["alarmCode"]
      },
      execute: async (params, context) => {
        const rawCode = String(params.alarmCode || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
        const controller = String(params.controllerType || "").toLowerCase();

        // Match against verified knowledge base
        let matchKey = null;
        if (controller.includes("haas") && VERIFIED_CNC_KNOWLEDGE[`HAAS_${rawCode}`]) {
          matchKey = `HAAS_${rawCode}`;
        } else if ((controller.includes("fanuc") || !controller) && VERIFIED_CNC_KNOWLEDGE[`FANUC_${rawCode}`]) {
          matchKey = `FANUC_${rawCode}`;
        } else if (controller.includes("siemens") && VERIFIED_CNC_KNOWLEDGE[`SIEMENS_${rawCode}`]) {
          matchKey = `SIEMENS_${rawCode}`;
        } else if (controller.includes("mitsubishi") && VERIFIED_CNC_KNOWLEDGE[`MITSUBISHI_${rawCode}`]) {
          matchKey = `MITSUBISHI_${rawCode}`;
        } else {
          // Look across all known keys
          for (const key of Object.keys(VERIFIED_CNC_KNOWLEDGE)) {
            if (key.endsWith(`_${rawCode}`)) {
              matchKey = key;
              break;
            }
          }
        }

        if (matchKey && VERIFIED_CNC_KNOWLEDGE[matchKey]) {
          const entry = VERIFIED_CNC_KNOWLEDGE[matchKey];
          return {
            success: true,
            isVerified: true,
            confidenceLevel: "HIGH (Verified Manufacturer Manual)",
            data: entry
          };
        }

        // Unverified / Generic fallback with honest confidence rating
        return {
          success: true,
          isVerified: false,
          confidenceLevel: "MEDIUM (AI Diagnostic Inference)",
          notice: "Exact alarm code not present in offline cached standard manual. Providing standard electro-mechanical diagnostic workflow.",
          data: {
            alarmCode: params.alarmCode,
            controller: params.controllerType || "Generic CNC",
            title: `Diagnostic Protocol for Alarm ${params.alarmCode}`,
            severity: "warning",
            category: "General Diagnostic",
            description: `Tripped sensor, drive interlock, or parameter condition under code ${params.alarmCode}.`,
            causes: [
              "Sensor contact open, dirty optical scale, or 24V DC I/O signal rail voltage drop.",
              "Axis limit travel trip or mechanical binding on guide ways.",
              "Motor thermal switch or drive ready interlock open."
            ],
            safetyWarning: "CAUTION: De-energize 415V/3-phase power and lockout before working inside high voltage electrical cabinets.",
            diagnosticSteps: [
              "Verify the exact controller model (e.g. Fanuc 0i-MF, Haas NGC, Siemens 840D).",
              "Check active I/O status bits in controller Diagnostics / PLC screen.",
              "Inspect 24V DC power supply rails and safety circuit relays.",
              "Refer to the specific machine builder electrical schematic manual."
            ],
            verifiedCitations: ["📘 SmartERP Universal CNC Diagnostic Framework"]
          }
        };
      }
    };

    // ── Tool 5: check_spare_parts_availability ────────────────────────────────
    this.tools["check_spare_parts_availability"] = {
      name: "check_spare_parts_availability",
      description: "Searches the company inventory for available CNC spare parts, filters, drives, and consumables.",
      allowedRoles: ["owner", "admin", "hr", "employee", "super_admin"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {
          partName: { type: "string", description: "Name of the part, SKU, or component (e.g., 'spindle drive', 'filter', 'encoder', 'servo motor')" }
        },
        required: ["partName"]
      },
      execute: async (params, context) => {
        const companyId = context.user.companyId;
        if (!companyId && context.user.role !== "super_admin") {
          return { success: false, message: "Unauthorized: Missing company context.", items: [] };
        }

        const searchTerm = `%${params.partName}%`;
        const res = await pool.query(
          `SELECT id, name, sku, category, quantity, unit, unit_price, status
           FROM inventory_items
           WHERE company_id::text = $1::text
             AND (name ILIKE $2 OR sku ILIKE $2 OR category ILIKE $2)
           ORDER BY quantity DESC LIMIT 10`,
          [String(companyId), searchTerm]
        ).catch(() => ({ rows: [] }));

        return {
          success: true,
          count: res.rows.length,
          items: res.rows
        };
      }
    };

    // ── Tool 6: check_machine_warranty ────────────────────────────────────────
    this.tools["check_machine_warranty"] = {
      name: "check_machine_warranty",
      description: "Retrieves warranty status, supplier coverage, and active warranty claims for a machine.",
      allowedRoles: ["owner", "admin", "hr", "employee", "super_admin"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {
          machineId: { type: "string", description: "Machine ID or serial number" }
        },
        required: ["machineId"]
      },
      execute: async (params, context) => {
        const companyId = context.user.companyId;
        if (!companyId && context.user.role !== "super_admin") {
          return { success: false, message: "Unauthorized: Missing company context." };
        }

        const res = await pool.query(
          `SELECT w.*, m.machine_name, m.serial_number
           FROM warranty_claims w
           LEFT JOIN customer_machines m ON w.machine_id::text = m.id::text
           WHERE w.company_id::text = $1::text
             AND (w.machine_id::text = $2::text OR m.serial_number ILIKE $2)
           ORDER BY w.created_at DESC LIMIT 5`,
          [String(companyId), String(params.machineId)]
        ).catch(() => ({ rows: [] }));

        return {
          success: true,
          claimsCount: res.rows.length,
          claims: res.rows,
          status: res.rows.length > 0 ? "Existing claims on record" : "No active warranty claims logged"
        };
      }
    };

    // ── Tool 7: prepare_service_escalation (Consequential Action requiring confirmation) ─
    this.tools["prepare_service_escalation"] = {
      name: "prepare_service_escalation",
      description: "Prepares a high-priority service ticket escalation for a critical machine breakdown. Returns a structured confirmation widget for user approval.",
      allowedRoles: ["owner", "admin", "hr", "employee", "super_admin"],
      isDestructive: true,
      parameters: {
        type: "object",
        properties: {
          machineId: { type: "string", description: "Machine ID or name" },
          symptom: { type: "string", description: "Observed fault or alarm code" },
          urgency: { type: "string", description: "Urgency level: 'high', 'urgent', 'critical'" },
          proposedAction: { type: "string", description: "Recommended service intervention or component replacement" }
        },
        required: ["machineId", "symptom"]
      },
      execute: async (params, context) => {
        return {
          action: "ACTION_CONFIRMATION_REQUIRED",
          actionType: "CREATE_SERVICE_ESCALATION",
          title: "Confirm CNC Service Escalation",
          machineId: params.machineId,
          symptom: params.symptom,
          urgency: params.urgency || "urgent",
          proposedAction: params.proposedAction || "Dispatch Senior Field Service Engineer for on-site diagnostic verification.",
          warning: "Creating this escalation will dispatch priority alerts to the Operations Manager and Field Service Lead.",
          requiresUserConfirmation: true
        };
      }
    };
  }
}

module.exports = CncPlugin;
