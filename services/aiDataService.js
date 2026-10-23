const { pool } = require("../db");
const AttendancePolicy = require('./attendancePolicyService');

class AIDataService {
  /** Narrow company-scoped job counts for common AI questions. */
  static async getCompanyJobStatusCounts({ companyId }) {
    if (!companyId) throw new Error("Company ID is required.");
    const result = await pool.query(
      `SELECT LOWER(COALESCE(status, 'open')) AS status, COUNT(*)::int AS count
         FROM jobs
        WHERE company_id::text = $1
        GROUP BY LOWER(COALESCE(status, 'open'))`,
      [String(companyId)]
    );
    return Object.fromEntries((result.rows || []).map((row) => [row.status, Number(row.count) || 0]));
  }

  /** Employee-only active job count, restricted to their existing assignments. */
  static async getEmployeeActiveJobCount({ userId, companyId }) {
    if (!userId || !companyId) throw new Error("User and company IDs are required.");
    const result = await pool.query(
      `SELECT COUNT(*)::int AS active_count
         FROM jobs
        WHERE company_id::text = $2
          AND (assigned_employee_id::text = $1 OR assigned_to::text = $1)
          AND LOWER(COALESCE(status, 'open')) NOT IN ('completed', 'closed', 'cancelled')`,
      [String(userId), String(companyId)]
    );
    return Number(result.rows?.[0]?.active_count) || 0;
  }

  /** Returns only jobs directly assigned to one employee within their company. */
  static async getEmployeeAssignedJobs({ userId, companyId, status, limit = 10 }) {
    if (!userId || !companyId) throw new Error("User and company IDs are required.");
    const safeLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
    const values = [String(userId), String(companyId)];
    let statusClause = "";
    if (status) {
      values.push(String(status).trim());
      statusClause = ` AND LOWER(COALESCE(j.status, 'open')) = LOWER($${values.length})`;
    }
    values.push(safeLimit);

    const result = await pool.query(
      `SELECT j.id, j.title, j.status, j.priority, j.created_at,
              COUNT(*) OVER()::int AS total_count
         FROM jobs j
        WHERE j.company_id::text = $2
          AND (j.assigned_employee_id::text = $1 OR j.assigned_to::text = $1)${statusClause}
        ORDER BY j.created_at DESC
        LIMIT $${values.length}`,
      values
    );
    const rows = result.rows || [];
    return {
      totalCount: Number(rows[0]?.total_count) || 0,
      jobs: rows.map(({ total_count, ...job }) => job),
    };
  }

  /** Returns only an employee's assigned overdue jobs within their company. */
  static async getEmployeeDelayedJobs({ userId, companyId }) {
    if (!userId || !companyId) throw new Error("User and company IDs are required.");
    const result = await pool.query(
      `SELECT DISTINCT j.id, j.title, j.status, j.priority, j.created_at
         FROM jobs j
        WHERE j.company_id::text = $2
          AND (j.assigned_employee_id::text = $1 OR j.assigned_to::text = $1)
          AND LOWER(COALESCE(j.status, 'open')) NOT IN ('completed', 'closed', 'cancelled')
          AND j.created_at < NOW() - INTERVAL '7 days'
        ORDER BY j.created_at ASC`,
      [String(userId), String(companyId)]
    );
    return { delayedCount: result.rows?.length || 0, delayedJobs: result.rows || [] };
  }

  /** Narrow company-scoped low-stock count without loading unrelated modules. */
  static async getCompanyLowStockCount({ companyId }) {
    if (!companyId) throw new Error("Company ID is required.");
    const result = await pool.query(
      `SELECT COUNT(*)::int AS low_stock_count
         FROM inventory_items
        WHERE company_id::text = $1
          AND (is_deleted = FALSE OR is_deleted IS NULL)
          AND min_quantity > 0
          AND quantity < min_quantity`,
      [String(companyId)]
    );
    return Number(result.rows?.[0]?.low_stock_count) || 0;
  }

  /** Invoice-only summary, avoiding failures in unrelated attendance/HR queries. */
  static async getCompanyInvoiceSummary({ companyId }) {
    if (!companyId) throw new Error("Company ID is required.");
    const [result, payments] = await Promise.all([pool.query(
      `SELECT COUNT(*)::int AS total_invoices,
              COUNT(*) FILTER (WHERE status = 'issued')::int AS pending_count,
              COALESCE(SUM(CASE WHEN status = 'issued' THEN total_amount ELSE 0 END), 0) AS pending_amount,
              COUNT(*) FILTER (WHERE status = 'issued' AND due_date < CURRENT_DATE)::int AS overdue_count
         FROM invoices
        WHERE company_id::text = $1`,
      [String(companyId)]
    ), pool.query(
      `SELECT COALESCE(SUM(CASE WHEN DATE(created_at) = CURRENT_DATE THEN amount ELSE 0 END), 0) AS today_revenue,
              COALESCE(SUM(CASE WHEN DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE) THEN amount ELSE 0 END), 0) AS month_revenue
         FROM payments
        WHERE company_id::text = $1`,
      [String(companyId)]
    )]);
    const row = result.rows?.[0] || {};
    const paymentRow = payments.rows?.[0] || {};
    return {
      total: Number(row.total_invoices) || 0,
      pending: Number(row.pending_count) || 0,
      pendingAmount: Number(row.pending_amount) || 0,
      overdue: Number(row.overdue_count) || 0,
      todayRevenue: Number(paymentRow.today_revenue) || 0,
      monthRevenue: Number(paymentRow.month_revenue) || 0,
    };
  }

  /** Pending leave count for authorized HR roles or an employee's own requests. */
  static async getPendingLeaveCount({ companyId, userId = null, personal = false }) {
    if (!companyId || (personal && !userId)) throw new Error("User and company IDs are required.");
    const result = personal
      ? await pool.query(
          `SELECT COUNT(*)::int AS pending_count
             FROM leave_requests
            WHERE company_id::text = $1 AND user_id::text = $2 AND status = 'pending'`,
          [String(companyId), String(userId)]
        )
      : await pool.query(
          `SELECT COUNT(*)::int AS pending_count
             FROM leave_requests
            WHERE company_id::text = $1 AND status = 'pending'`,
          [String(companyId)]
        );
    return Number(result.rows?.[0]?.pending_count) || 0;
  }

  /**
   * Company-wide attendance counts for roles allowed to view workforce data.
   * Keep this query narrow: the AI attendance resolver must not read unrelated
   * financial or inventory data just to answer an attendance question.
   */
  static async getCompanyAttendanceSummary({ companyId }) {
    const cid = String(companyId);
    const policy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
    const workDate = AttendancePolicy.localDate(new Date(), policy.timezone);
    const result = await pool.query(
      `SELECT a.check_in_time, a.status, a.is_late,
              EXISTS (
                SELECT 1
                  FROM leave_requests l
                 WHERE l.user_id::text = u.id::text
                   AND l.company_id::text = u.company_id::text
                   AND l.status = 'approved'
                   AND $2::date BETWEEN l.start_date AND l.end_date
              ) AS is_on_leave
         FROM users u
         LEFT JOIN attendance a
           ON a.user_id::text = u.id::text
          AND a.company_id::text = u.company_id::text
          AND a.date = $2
        WHERE u.company_id::text = $1
          AND u.is_active = TRUE
          AND COALESCE(NULLIF(to_jsonb(u)->>'status', ''), 'active') <> 'suspended'
          AND u.role = 'employee'`,
      [cid, workDate]
    );

    const rows = result.rows || [];
    const attended = (row) => Boolean(row.check_in_time) || ["present", "late", "half_day"].includes(row.status);
    const onLeave = (row) => !attended(row) && row.is_on_leave === true;
    const present = rows.filter(attended).length;
    const onLeaveCount = rows.filter(onLeave).length;
    return {
      total: rows.length,
      present,
      absent: rows.length - present - onLeaveCount,
      late: rows.filter((row) => row.is_late === true || row.status === "late").length,
      on_leave: onLeaveCount,
    };
  }

  /**
   * Owner AI Summary: Live enterprise operational metrics strictly scoped by companyId
   */
  static async getOwnerDashboardSummary({ companyId }) {
    const cid = String(companyId);
    const policy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
    const workDate = AttendancePolicy.localDate(new Date(), policy.timezone);

    const [
      jobsRes,
      revenueRes,
      invoiceRes,
      attendanceRes,
      inventoryRes,
      leavesRes,
      leavesTodayRes,
    ] = await Promise.all([
      // Jobs breakdown
      pool.query(
        `SELECT status, COUNT(*) as count 
         FROM jobs 
         WHERE company_id::text = $1 
         GROUP BY status`,
        [cid]
      ),

      // Today's revenue & monthly revenue
      pool.query(
        `SELECT 
           COALESCE(SUM(CASE WHEN DATE(created_at) = CURRENT_DATE THEN amount ELSE 0 END), 0) as today_revenue,
           COALESCE(SUM(CASE WHEN DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE) THEN amount ELSE 0 END), 0) as month_revenue
         FROM payments 
         WHERE company_id::text = $1`,
        [cid]
      ),

      // Pending invoices & overdue
      pool.query(
        `SELECT 
           COUNT(*) as total_invoices,
           COUNT(*) FILTER (WHERE status = 'issued') as pending_count,
           COALESCE(SUM(CASE WHEN status = 'issued' THEN total_amount ELSE 0 END), 0) as pending_amount,
           COUNT(CASE WHEN status = 'issued' AND due_date < CURRENT_DATE THEN 1 END) as overdue_count
         FROM invoices 
         WHERE company_id::text = $1`,
        [cid]
      ),

      // Today's attendance overview & active employees (mirroring canonical routes/attendance.js)
      pool.query(
        `SELECT 
           u.id as user_id,
           u.name as employee_name,
           u.email as employee_email,
           a.id as attendance_id,
           a.date,
           a.check_in_time,
           a.check_out_time,
           a.working_hours,
           a.status,
           a.is_late
         FROM users u
         LEFT JOIN attendance a ON u.id::text = a.user_id::text AND a.company_id::text = u.company_id::text AND a.date = $2
         WHERE (u.role = 'employee' OR (u.role != 'owner' AND u.role != 'admin' AND u.role != 'customer'))
           AND u.is_active = TRUE
           AND COALESCE(NULLIF(to_jsonb(u)->>'status', ''), 'active') <> 'suspended'
           AND (u.company_id = $1 OR u.company_id::text = $1::text)
         ORDER BY u.name ASC`,
        [cid, workDate]
      ),

      // Low stock inventory items
      pool.query(
        `SELECT name, quantity, min_stock_level 
         FROM inventory 
         WHERE company_id::text = $1 AND quantity <= min_stock_level 
         LIMIT 5`,
        [cid]
      ),

      // Pending leave requests
      pool.query(
        `SELECT COUNT(*) as pending_leaves 
         FROM leave_requests 
         WHERE company_id::text = $1 AND status = 'pending'`,
        [cid]
      ),

      // Approved leaves for today
      pool.query(
        `SELECT COUNT(*) as on_leave_count
         FROM leave_requests
         WHERE (company_id = $1 OR company_id::text = $1::text)
           AND status = 'approved'
           AND $2::date BETWEEN start_date AND end_date`,
        [cid, workDate]
      ),
    ]);

    const jobCounts = {};
    jobsRes.rows.forEach((r) => (jobCounts[r.status] = parseInt(r.count, 10)));

    const attendanceRows = attendanceRes.rows || [];
    const totalStaff = attendanceRows.length;
    const presentStaff = attendanceRows.filter(
      (r) => r.check_in_time || ["present", "late", "half_day"].includes(r.status)
    ).length;
    const absentStaff = attendanceRows.filter(
      (r) => !r.check_in_time && !["present", "late", "half_day"].includes(r.status)
    ).length;
    const lateStaff = attendanceRows.filter(
      (r) => r.is_late || r.status === "late"
    ).length;
    const onLeaveStaff = parseInt(leavesTodayRes.rows[0]?.on_leave_count || 0, 10);

    return {
      jobs: {
        completed: jobCounts.completed || 0,
        in_progress: jobCounts.in_progress || 0,
        pending: jobCounts.pending || jobCounts.open || 0,
        total: Object.values(jobCounts).reduce((a, b) => a + b, 0),
      },
      revenue: {
        today: Number(revenueRes.rows[0]?.today_revenue || 0),
        this_month: Number(revenueRes.rows[0]?.month_revenue || 0),
      },
      invoices: {
        total: parseInt(invoiceRes.rows[0]?.total_invoices || 0, 10),
        pending_count: parseInt(invoiceRes.rows[0]?.pending_count || 0, 10),
        pending_amount: Number(invoiceRes.rows[0]?.pending_amount || 0),
        overdue_count: parseInt(invoiceRes.rows[0]?.overdue_count || 0, 10),
      },
      attendance: {
        total: totalStaff,
        present: presentStaff,
        absent: absentStaff,
        late: lateStaff,
        on_leave: onLeaveStaff,
        records: attendanceRows,
      },
      employees: {
        active_count: totalStaff,
        today_attendance: {
          total: totalStaff,
          present: presentStaff,
          absent: absentStaff,
          late: lateStaff,
        },
      },
      inventory: {
        low_stock_items: inventoryRes.rows,
        low_stock_count: inventoryRes.rows.length,
      },
      leaves: {
        pending_requests: parseInt(leavesRes.rows[0]?.pending_leaves || 0, 10),
        on_leave_today: onLeaveStaff,
      },
    };
  }

  /**
   * Employee AI Summary: Personal workspace data strictly scoped to userId
   */
  static async getEmployeeDashboardSummary({ userId, companyId }) {
    const uid = String(userId);
    const cid = String(companyId);
    const policy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
    const workDate = AttendancePolicy.localDate(new Date(), policy.timezone);

    const [jobsRes, attendanceRes, leavesRes, materialsRes] = await Promise.all([
      // Employee's assigned jobs
      pool.query(
        `SELECT id, title, status, priority, created_at
         FROM jobs 
         WHERE company_id::text = $2
           AND (assigned_employee_id::text = $1 OR assigned_to::text = $1)
         ORDER BY created_at DESC LIMIT 10`,
        [uid, cid]
      ),

      // Attendance history for this month
      pool.query(
        `SELECT date, check_in_time as clock_in, check_out_time as clock_out, check_in_time, check_out_time, status, working_hours, is_late 
         FROM attendance 
         WHERE user_id::text = $1 AND company_id::text = $2
           AND date >= date_trunc('month', $3::date)::date AND date <= $4::date
         ORDER BY date DESC LIMIT 10`,
        [uid, cid, workDate.slice(0, 7) + '-01', workDate]
      ),

      // Employee's leave requests
      pool.query(
        `SELECT leave_type, start_date, end_date, status, reason 
         FROM leave_requests 
         WHERE user_id::text = $1 AND company_id::text = $2
         ORDER BY created_at DESC LIMIT 5`,
        [uid, cid]
      ),

      // Employee's material requests
      pool.query(
        `SELECT item_name, quantity, status, urgency 
         FROM material_requests 
         WHERE requested_by::text = $1 AND company_id::text = $2
         ORDER BY created_at DESC LIMIT 5`,
        [uid, cid]
      ),
    ]);

    const completedJobs = jobsRes.rows.filter((j) => j.status === "completed").length;
    const activeJobs = jobsRes.rows.filter((j) => j.status !== "completed").length;

    return {
      assigned_jobs: jobsRes.rows,
      summary: {
        active_jobs: activeJobs,
        completed_jobs: completedJobs,
      },
      recent_attendance: attendanceRes.rows,
      leave_requests: leavesRes.rows,
      material_requests: materialsRes.rows,
    };
  }

  /**
   * HR AI Summary: Workforce & HR Management metrics
   */
  static async getHrDashboardSummary({ companyId }) {
    const cid = String(companyId);
    const policy = await AttendancePolicy.getCompanyPolicy(companyId, pool);
    const workDate = AttendancePolicy.localDate(new Date(), policy.timezone);

    const [leavesRes, attendanceRes, employeesRes] = await Promise.all([
      // Pending leaves with employee details
      pool.query(
        `SELECT l.id, u.name as employee_name, l.leave_type, l.start_date, l.end_date, l.reason, l.status
         FROM leave_requests l
         LEFT JOIN users u ON l.user_id::text = u.id::text AND l.company_id::text = u.company_id::text
         WHERE l.company_id::text = $1 AND l.status = 'pending'`,
        [cid]
      ),

      // Today's attendance anomalies (late arrivals or absent staff)
      pool.query(
        `SELECT 
           u.id as user_id, 
           u.name, 
           a.check_in_time as clock_in, 
           COALESCE(a.status, 'absent') as status,
           a.is_late
         FROM users u
         LEFT JOIN attendance a ON u.id::text = a.user_id::text AND a.company_id::text = u.company_id::text AND a.date = $2
         WHERE (u.company_id = $1 OR u.company_id::text = $1::text)
           AND (u.role = 'employee' OR (u.role != 'owner' AND u.role != 'admin' AND u.role != 'customer'))
           AND (a.is_late = true OR a.status = 'late' OR a.check_in_time IS NULL)`,
        [cid, workDate]
      ),

      // Employee headcount by department
      pool.query(
        `SELECT u.department, COUNT(*) as count
         FROM users u
         WHERE u.company_id::text = $1 AND u.role = 'employee'
           AND u.is_active = TRUE
           AND COALESCE(NULLIF(to_jsonb(u)->>'status', ''), 'active') <> 'suspended'
         GROUP BY u.department`,
        [cid]
      ),
    ]);

    return {
      pending_leave_requests: leavesRes.rows,
      attendance_anomalies: attendanceRes.rows,
      department_headcount: employeesRes.rows,
    };
  }

  /**
   * Customer AI Summary: Customer-specific job requests, invoices & payments
   */
  static async getCustomerDashboardSummary({ customerId, email, companyId }) {
    const cid = String(companyId);

    const [jobsRes, invoicesRes] = await Promise.all([
      pool.query(
        `SELECT id, title, status, priority, stage, created_at 
         FROM jobs 
         WHERE company_id::text = $1 AND (customer_id::text = $2 OR customer_email = $3)
         ORDER BY created_at DESC LIMIT 10`,
        [cid, String(customerId || ""), String(email || "")]
      ),

      pool.query(
        `SELECT id, invoice_number, total_amount, status, due_date 
         FROM invoices 
         WHERE company_id::text = $1 AND (customer_id::text = $2 OR customer_email = $3)
         ORDER BY created_at DESC LIMIT 10`,
        [cid, String(customerId || ""), String(email || "")]
      ),
    ]);

    return {
      my_jobs: jobsRes.rows,
      my_invoices: invoicesRes.rows,
    };
  }

  /**
   * Audit log helper for recording AI Actions
   */
  static async logAction({ userId, userName, role, companyId, prompt, actionName, affectedRecordId, status = "SUCCESS", details = {} }) {
    try {
      await pool.query(
        `INSERT INTO ai_audit_logs 
         (user_id, user_name, role, company_id, prompt, action_name, affected_record_id, status, details, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        [String(userId || ""), userName || "User", role || "employee", companyId || null, prompt, actionName, String(affectedRecordId || ""), status, JSON.stringify(details)]
      );
    } catch (err) {
      console.warn("⚠️ AI Audit Logging failed:", err.message);
    }
  }
}

module.exports = AIDataService;
