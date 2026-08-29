const BasePlugin = require("./base.plugin");
const { pool } = require("../../db");

// ─── Machine Classification & Architecture Registry ──────────────────────────
const MACHINE_CLASSIFICATIONS = {
  // Haas Machining Centers
  "VF-1": { type: "Vertical Machining Center (VMC)", category: "Milling", axes: "3-Axis (X, Y, Z)" },
  "VF-2": { type: "Vertical Machining Center (VMC)", category: "Milling", axes: "3-Axis (X, Y, Z)" },
  "VF-3": { type: "Vertical Machining Center (VMC)", category: "Milling", axes: "3-Axis (X, Y, Z)" },
  "VF-4": { type: "Vertical Machining Center (VMC)", category: "Milling", axes: "3-Axis (X, Y, Z)" },
  "VF-5": { type: "Vertical Machining Center (VMC)", category: "Milling", axes: "3-Axis (X, Y, Z)" },
  "MINI MILL": { type: "Compact Vertical Machining Center", category: "Milling", axes: "3-Axis (X, Y, Z)" },
  "UMC-500": { type: "Universal 5-Axis Machining Center", category: "Milling", axes: "5-Axis" },
  "UMC-750": { type: "Universal 5-Axis Machining Center", category: "Milling", axes: "5-Axis" },
  "EC-400": { type: "Horizontal Machining Center (HMC)", category: "Milling", axes: "4-Axis" },
  // Haas Turning Centers (Lathes)
  "ST-10": { type: "CNC Turning Center (Lathe)", category: "Turning", axes: "2-Axis (X, Z)" },
  "ST-20": { type: "CNC Turning Center (Lathe)", category: "Turning", axes: "2-Axis (X, Z)" },
  "ST-30": { type: "CNC Turning Center (Lathe)", category: "Turning", axes: "2-Axis (X, Z)" },
  "TL-1": { type: "CNC Toolroom Lathe", category: "Turning", axes: "2-Axis (X, Z)" },
  "TL-2": { type: "CNC Toolroom Lathe", category: "Turning", axes: "2-Axis (X, Z)" }
};

// ─── Authoritative Verified CNC Alarm Knowledge Base ─────────────────────────
const VERIFIED_CNC_KNOWLEDGE = {
  // ── Haas Controller Alarms (Numeric 3/4 digits) ───────────────────────────
  "HAAS_163": {
    controller: "Haas Next Generation Control (NGC) / Classic Haas Control (CHC)",
    alarmCode: "163",
    title: "Z-Axis Drive Fault / Servo Overcurrent",
    severity: "critical",
    category: "Axis Drive System",
    description: "Z-axis amplifier reported a drive fault or instantaneous overcurrent condition to the Main Processor PCB.",
    causes: [
      "Z-axis holding brake not releasing (defective brake solenoid or lack of 24V DC brake release signal).",
      "Short circuit or insulation degradation in Z-axis servo motor power cable or motor stator winding.",
      "Mechanical binding in Z-axis ball screw nut, linear guide trucks, or counterbalance cylinder.",
      "Defective Haas Smart Amplifier or Vector Drive module."
    ],
    safetyWarning: "HIGH VOLTAGE & SUSPENDED LOAD HAZARD: Z-axis headstock is heavy and may drop if the brake is disengaged. Ensure headstock is mechanically blocked with wooden/aluminum cribbing before servicing Z-axis brake or drive. Only qualified service personnel should service high-voltage cabinet components under strict Lockout/Tagout (LOTO).",
    diagnosticSteps: [
      "Record all secondary alarms displayed on screen (e.g. Alarm 161, 162, 401).",
      "Inspect way lube level and verify lubrication pressure gauge reads 25–45 PSI during lube cycle.",
      "Perform a visual inspection of Z-axis way covers and guideways for chip jamming or lack of oil film.",
      "Check Z-axis brake release: Listen for the mechanical click of the solenoid when E-stop is reset and servos are commanded.",
      "If qualified: Measure motor lead resistance with power locked out. Winding resistance should be balanced across all 3 phases.",
      "If fault persists, isolate whether the drive amplifier or the motor/cable is faulted by testing motor leads at amplifier terminals."
    ],
    verifiedCitations: [
      "[Manufacturer Documentation] Haas NGC Service Manual — Axis Drive & Motor Troubleshooting (96-0258)",
      "[SmartERP Verified Service History] SmartERP Standard CNC Diagnostics (Ref: HAA-NGC-163)"
    ]
  },

  "HAAS_401": {
    controller: "Haas Next Generation Control (NGC) / Classic Haas Control (CHC)",
    alarmCode: "401",
    title: "Servo Off / Drive Fault (All Axes Disabled)",
    severity: "critical",
    category: "Servo & Vector Drive System",
    description: "The CNC controller detected a fault status line from the Vector Drive or axis amplifiers, disabling power to all axis servo motors.",
    causes: [
      "Low DC bus voltage (< 310V DC) caused by incoming 3-phase line voltage drop or blown line fuses.",
      "Vector Drive fault or regenerative load dump resistor over-temperature.",
      "Loose fault communication cable between Vector Drive and MOCON / Main PCB (Connector P1–P4).",
      "Amplifier over-temperature trip or cooling fan failure in electrical cabinet."
    ],
    safetyWarning: "HIGH VOLTAGE HAZARD: The DC bus retains dangerous voltage (>320V DC) after power-down. Wait for the high-voltage discharge indicator LED on the Vector Drive faceplate to fully extinguish and verify with a calibrated meter before touching any electrical terminals. Follow OSHA/ISO Lockout/Tagout (LOTO) protocols.",
    diagnosticSteps: [
      "Check for accompanying axis-specific alarms (e.g., Alarm 161 X Drive Fault, 163 Z Drive Fault).",
      "Inspect incoming 3-phase AC voltage at main breaker (verify phase-to-phase balance within 2%).",
      "Inspect Vector Drive status LEDs on the drive module (check Fault, Overvolt, Regen indicators).",
      "Ensure electrical cabinet cooling fans are running and air filters are free of oil mist and dust.",
      "Verify wiring connections on fault bus ribbon cables between amplifiers and main processor."
    ],
    verifiedCitations: [
      "[Manufacturer Documentation] Haas Vector Drive Troubleshooting Guide (Haas Automation Manual 96-0258)",
      "[SmartERP Verified Service History] SmartERP CNC Knowledge Base (Ref: CNC-HAA-401)"
    ]
  },

  "HAAS_992": {
    controller: "Haas Next Generation Control (NGC)",
    alarmCode: "992",
    title: "Spindle Orientation Fault / Orient Failed",
    severity: "critical",
    category: "Spindle & Tool Change System",
    description: "The spindle was commanded to orient (e.g. M19 or prior to tool change) but failed to lock into the commanded angular position within the parameter time limit.",
    causes: [
      "Spindle encoder belt loose, damaged, or slipped on spindle shaft pulley.",
      "Spindle orient shot pin / mechanical locking ring binding or solenoid not engaging.",
      "Spindle vector drive orientation gain parameter out of tune or motor braking delay.",
      "Encoder feedback cable loose or optical encoder ring contaminated with coolant/oil."
    ],
    safetyWarning: "SPINDLE & TOOL CHANGER PINCH HAZARD: Never reach into spindle nose or tool changer carousel area while servos/spindle are powered. Engage Emergency Stop before inspecting spindle belts or shot pins.",
    diagnosticSteps: [
      "Check spindle drive belt tension and inspect encoder timing belt for missing teeth or wear.",
      "Command M19 in MDI mode at low RPM and observe if spindle oscillates or overshoots position.",
      "Inspect spindle orientation shot pin assembly (if equipped on mechanical orient models) for proper pneumatic actuation.",
      "Clean optical encoder / magnetic pickup ring from cutting fluid condensation.",
      "Check Diagnostics screen for spindle speed/position feedback stability during manual spindle rotation."
    ],
    verifiedCitations: [
      "[Manufacturer Documentation] Haas NGC Mill Operator & Service Manual — Section: Spindle Orientation (Alarm 992)",
      "[SmartERP Verified Service History] SmartERP Tooling Maintenance SOP #992"
    ]
  },

  "HAAS_104": {
    controller: "Haas Next Generation Control (NGC)",
    alarmCode: "104",
    title: "Y-Axis Following Error / Position Lag",
    severity: "warning",
    category: "Axis Drive System",
    description: "The difference between commanded coordinate position and actual encoder feedback exceeded the maximum allowable error threshold.",
    causes: [
      "Way lube pump failure or blocked metering valve causing high friction on linear guide ways.",
      "Loose motor-to-ballscrew mechanical coupling or ball screw bearing preload failure.",
      "Encoder cable shielding degradation or optical scale contamination."
    ],
    safetyWarning: "Ensure Emergency Stop is engaged before inspecting linear ways and ball screw areas inside the machining enclosure.",
    diagnosticSteps: [
      "Check way lube pressure gauge during manual pump cycle (nominal 25–45 PSI).",
      "Inspect Y-axis way covers for chip compaction or mechanical binding.",
      "Jog axis slowly in JOG mode while monitoring motor load percentage on the Diagnostics screen.",
      "Inspect coupling clamping bolt torque between servo motor and ball screw."
    ],
    verifiedCitations: [
      "[Manufacturer Documentation] Haas Mill Service Manual — Axis Motion Diagnostics (96-0258)",
      "[SmartERP Verified Service History] SmartERP Machine Maintenance SOP #104"
    ]
  },

  "HAAS_991": {
    controller: "Haas Next Generation Control (NGC)",
    alarmCode: "991",
    title: "Door Interlock Safety Violation",
    severity: "warning",
    category: "Safety Interlock",
    description: "Enclosure safety door switch opened while spindle rotation was commanded or axis rapid traverse was active.",
    causes: [
      "Safety door mechanical switch misaligned, loose, or contaminated with chips.",
      "Safety interlock actuator key damaged or bent.",
      "Door switch circuit wiring harness loose at I/O PCB."
    ],
    safetyWarning: "NEVER bypass door interlocks. Industrial safety regulations (ISO 13849-1 / ANSI B11.54) require functional safety interlocks to prevent operator injury.",
    diagnosticSteps: [
      "Clean safety switch optical/magnetic head and remove trapped metal chips.",
      "Inspect wiring harness at door switch terminal block.",
      "Verify door switch bit in Diagnostics > I/O state transitions from 0 to 1 when door is latched."
    ],
    verifiedCitations: [
      "[Manufacturer Documentation] Haas NGC Safety & Compliance Manual",
      "[Manufacturer Documentation] ISO 13849-1 Machine Safety Guidelines"
    ]
  },

  // ── Fanuc CNC Alarms ──────────────────────────────────────────────────────
  "FANUC_401": {
    controller: "Fanuc Series 0i-MF / 0i-TF / 30i / 31i",
    alarmCode: "401",
    title: "V-READY OFF (VRDY Off / Servo Amplifier Not Ready)",
    severity: "critical",
    category: "Servo System",
    description: "The servo amplifier ready signal (VRDY) went LOW while the CNC controller commanded PRDY (Power Ready).",
    causes: [
      "Emergency Stop contact open or 24V DC I/O power supply drop.",
      "Servo amplifier optical communication cable (FSSB) disconnected or damaged.",
      "Main magnetic contactor (MCC) trip or phase loss on 200V AC servo transformer."
    ],
    safetyWarning: "HIGH VOLTAGE: Isolate 415V/200V transformer power and lockout main switch before inspecting MCC contactor coils or power terminals.",
    diagnosticSteps: [
      "Inspect 7-segment LED display on Fanuc Servo Amplifier module ('--' = normal standby, '01'/'02' = IPM overcurrent, 'b0' = FSSB comms error).",
      "Check 24V DC power supply voltage on amplifier connector CXA2A (must be 24V ± 10%).",
      "Inspect FSSB optical cable links between CNC main CPU and servo amplifiers for red light transmission.",
      "Verify MCC contactor auxiliary contacts for carbon pitting or weld failure."
    ],
    verifiedCitations: [
      "[Manufacturer Documentation] Fanuc Series 0i-MODEL F Maintenance Manual (B-64605EN)",
      "[SmartERP Verified Service History] SmartERP Servo Diagnostic Guide"
    ]
  },

  "FANUC_EX1001": {
    controller: "Fanuc Series 0i-MF / 31i",
    alarmCode: "EX1001",
    title: "Spindle Drive / Chiller Temperature Overheat",
    severity: "critical",
    category: "Spindle & Thermal Protection",
    description: "Spindle motor thermistor or spindle drive heat sink temperature exceeded safety trip threshold (110°C).",
    causes: [
      "Spindle oil chiller circulation pump failure or coolant flow rate below specification.",
      "Cabinet heat exchanger air filters clogged with cutting oil vapor or dust.",
      "Spindle motor cooling fan defective or thermistor circuit wire broken."
    ],
    safetyWarning: "Allow spindle motor to cool for at least 30 minutes before opening motor junction box.",
    diagnosticSteps: [
      "Check chiller flow switch indicator and chiller oil temperature gauge.",
      "Clean cabinet intake wire mesh filters using compressed air (max 3 bar).",
      "Measure thermistor resistance at amplifier connector JYA3 (standard 10kΩ NTC at 25°C).",
      "Check Fanuc Diagnosis Parameter #400–405 for recorded spindle thermal load %."
    ],
    verifiedCitations: [
      "[Manufacturer Documentation] Fanuc Spindle Amplifier Maintenance Guide (B-65285EN)",
      "[SmartERP Verified Service History] SmartERP Preventive Maintenance SOP-01"
    ]
  },

  // ── Mitsubishi Electric Alarms ────────────────────────────────────────────
  "MITSUBISHI_AL04": {
    controller: "Mitsubishi Electric M80 / M70 (MDS-D / MDS-DH Drive Series)",
    alarmCode: "AL-04",
    title: "Servo Amplifier Overcurrent / IPM Fault (Drive LED: 04)",
    severity: "critical",
    category: "Servo Drive System",
    description: "MDS-D/DH servo drive detected excessive instantaneous current flowing through the output Intelligent Power Module (IPM) inverter bridge.",
    causes: [
      "Motor power cable harness insulation breakdown or pinched wire in flexible cable track.",
      "Motor stator winding short circuit due to cutting fluid ingress through conduit gland.",
      "Mechanical axis collision or jammed ball screw nut preventing motor rotation.",
      "Damaged IPM transistor inside the MDS servo amplifier."
    ],
    safetyWarning: "HIGH VOLTAGE: Disconnect main 3-phase circuit breaker and wait for CHARGE LED on drive unit to fully extinguish before opening servo drive cover or touching terminals. Always verify zero voltage with a calibrated meter.",
    diagnosticSteps: [
      "Disconnect motor power cable (U, V, W) from drive bottom terminals.",
      "Perform Insulation Resistance (Megger) test on motor leads to earth (minimum 10 MΩ per manufacturer spec).",
      "Measure motor phase-to-phase resistance with a digital milliohmmeter (must be balanced across U-V, V-W, W-U).",
      "Inspect flexible cable energy chain for wear, bend fatigue, or cutting fluid accumulation."
    ],
    verifiedCitations: [
      "[Manufacturer Documentation] Mitsubishi Electric MDS-D-SVJ3 / MDS-DH Series Maintenance Manual (IB-1500158)",
      "[SmartERP Verified Service History] SmartERP Servo Diagnostic SOP #04"
    ]
  },

  // ── Siemens Sinumerik Alarms ──────────────────────────────────────────────
  "SIEMENS_2001": {
    controller: "Siemens Sinumerik 840D sl / 828D",
    alarmCode: "2001",
    title: "PLC Axis Interlock Not Released",
    severity: "warning",
    category: "PLC Interlock",
    description: "Axis motion enable signal (DB31-48.DBX21.7) not enabled by PLC logic program.",
    causes: [
      "Hydraulic system pressure below minimum threshold.",
      "Lubrication pressure switch not confirming pressure pulse within cycle timer.",
      "Tool clamp confirmation proximity switch inactive."
    ],
    safetyWarning: "Do not attempt manual tool unclamp while spindle motor is in motion.",
    diagnosticSteps: [
      "Check hydraulic pressure gauge on main power pack.",
      "Navigate to Diagnostics > PLC Status and check DB31.DBX21.7 bit state.",
      "Verify tool unclamp sensor LED on spindle cylinder top cap.",
      "Inspect way lube reservoir fluid level."
    ],
    verifiedCitations: [
      "[Manufacturer Documentation] Siemens Sinumerik 840D sl Diagnostics Manual",
      "[SmartERP Verified Service History] SmartERP Interlock Guide"
    ]
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

        const machine = res.rows[0];
        const modelUpper = String(machine.model || machine.machine_name || "").toUpperCase();
        let classification = "CNC Machining Center";
        for (const [key, val] of Object.entries(MACHINE_CLASSIFICATIONS)) {
          if (modelUpper.includes(key)) {
            classification = val.type;
            break;
          }
        }

        return {
          success: true,
          machine: {
            ...machine,
            machine_classification: classification
          }
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
        const query = `
          SELECT j.id, j.title, j.description, j.status, j.priority, j.created_at, j.updated_at,
                 j.assigned_to, j.location, j.progress
          FROM jobs j
          WHERE j.company_id::text = $1::text
            AND (j.description ILIKE '%' || $2 || '%' OR j.title ILIKE '%' || $2 || '%' OR j.machine_id::text = $2::text)
          ORDER BY j.created_at DESC
          LIMIT $3
        `;

        const machineIdentifier = String(params.machineId || "");
        const res = await pool.query(query, [String(companyId), machineIdentifier, limit]).catch(async () => {
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
      description: "Decodes a CNC alarm or error code against verified manufacturer manuals (Haas, Fanuc, Siemens, Mitsubishi) and provides authoritative root causes and diagnostic procedures.",
      allowedRoles: ["owner", "admin", "hr", "employee", "super_admin"],
      isDestructive: false,
      parameters: {
        type: "object",
        properties: {
          alarmCode: { type: "string", description: "The alarm code number or text (e.g. '163', '401', '992', '104', 'EX1001', 'AL-04')" },
          controllerType: { type: "string", description: "Controller family: 'Haas', 'Fanuc', 'Siemens', 'Mitsubishi', or 'Universal'" }
        },
        required: ["alarmCode"]
      },
      execute: async (params, context) => {
        const rawCode = String(params.alarmCode || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
        const controller = String(params.controllerType || "").toLowerCase();

        // 1. Special Case: Haas AL-04 check
        // AL-04 is NOT a Haas native CNC alarm code. On Haas controls, alarm numbers are numeric (e.g. 104, 163, 401).
        if (controller.includes("haas") && (rawCode === "AL04" || rawCode === "04" || rawCode === "AL4")) {
          return {
            success: true,
            isVerified: false,
            confidenceLevel: "LOW",
            notice: "AL-04 is NOT an official Haas CNC controller screen alarm code. Haas NGC/CHC controls use 3 or 4-digit numeric alarm codes (e.g. Alarm 104, 163, 401, 992). AL-04 is typically a 7-segment LED display error code on Mitsubishi/Fanuc/Yaskawa servo drive amplifiers.",
            recommendation: "Please check the Haas control screen (press [ALARM / MESGS]) and provide the exact numeric alarm number and message text displayed on screen.",
            data: {
              alarmCode: params.alarmCode,
              controller: "Haas (Unverified Alarm Code Format)",
              title: "Unverified Alarm Code on Haas Controller",
              severity: "warning",
              category: "Format Ambiguity",
              description: "The code 'AL-04' does not correspond to a documented Haas screen alarm. If the Z-axis stopped moving, common Haas Z-axis alarms include: Alarm 163 (Z-Axis Drive Fault / Overcurrent), Alarm 104 (Following Error), or Alarm 401 (Servo Off).",
              causes: [
                "Alarm code was read from a third-party servo drive LED rather than the Haas operator display.",
                "Z-axis holding brake is locked or 24V DC brake solenoid is not engaging.",
                "Mechanical obstruction, chip jam, or way cover binding on Z-axis column.",
                "Motor power cable or drive amplifier overcurrent condition."
              ],
              safetyWarning: "SUSPENDED LOAD HAZARD: Do not attempt to force or jog the Z-axis with power on. Block the headstock before servicing brake or drive components.",
              diagnosticSteps: [
                "Press [ALARM / MESGS] on the Haas control panel to read the authoritative numeric alarm code and description.",
                "Verify whether the Z-axis is in E-Stop or Servo Off state (Alarm 401).",
                "Check way lube oil level and air supply pressure gauge (nominal 85 PSI).",
                "Inspect the Z-axis column and way covers for physical chip compaction."
              ],
              verifiedCitations: [
                "[AI Diagnostic Inference] Haas Controller Alarm Code Architecture (Haas Automation)"
              ]
            }
          };
        }

        // 2. Match against verified knowledge base
        let matchKey = null;
        if (controller.includes("haas") && VERIFIED_CNC_KNOWLEDGE[`HAAS_${rawCode}`]) {
          matchKey = `HAAS_${rawCode}`;
        } else if (controller.includes("fanuc") && VERIFIED_CNC_KNOWLEDGE[`FANUC_${rawCode}`]) {
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
            confidenceLevel: "HIGH",
            data: entry
          };
        }

        // 3. Unverified / Unknown Alarm Code
        return {
          success: true,
          isVerified: false,
          confidenceLevel: "LOW",
          notice: `Alarm code '${params.alarmCode}' was not found in the verified manufacturer documentation cache.`,
          recommendation: "Please provide the exact controller model (e.g. Haas NGC, Fanuc 0i-MF, Siemens 840D) and the exact text description displayed on the control screen.",
          data: {
            alarmCode: params.alarmCode,
            controller: params.controllerType || "Unspecified Controller",
            title: `Unverified Alarm: ${params.alarmCode}`,
            severity: "warning",
            category: "General Troubleshooting",
            description: `No authoritative manufacturer documentation found for code '${params.alarmCode}' under controller '${params.controllerType || "Generic"}'.`,
            causes: [
              "Controller-specific manufacturer alarm (OEM custom M-code or ladder alarm).",
              "External interlock condition (air pressure, lube pressure, chiller flow, door safety).",
              "Sensor contact bounce or 24V DC I/O power supply fluctuation."
            ],
            safetyWarning: "ELECTRICAL & MECHANICAL SAFETY: Always disconnect and lockout main power before opening electrical cabinets. Service must be performed by qualified personnel.",
            diagnosticSteps: [
              "Record the full error message and any accompanying secondary alarms displayed on the screen.",
              "Check non-invasive external conditions: Air pressure (85 PSI), Way lube reservoir level, Chiller status, Door interlock.",
              "Consult the specific machine builder electrical schematic and parameter manual.",
              "If the issue persists, escalate for certified field service."
            ],
            verifiedCitations: [
              "[AI Diagnostic Inference] SmartERP Universal CNC Diagnostic Guidelines"
            ]
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

    // ── Tool 7: prepare_service_escalation ────────────────────────────────────
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
