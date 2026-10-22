const { pool } = require("../db");
const AttendancePolicy = require('./attendancePolicyService');

class AIDataService {
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
          AND COALESCE(u.status, 'active') <> 'suspended'
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
      ).catch(() => ({ rows: [] })),

      // Today's revenue & monthly revenue
      pool.query(
        `SELECT 
           COALESCE(SUM(CASE WHEN DATE(created_at) = CURRENT_DATE THEN amount ELSE 0 END), 0) as today_revenue,
           COALESCE(SUM(CASE WHEN DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE) THEN amount ELSE 0 END), 0) as month_revenue
         FROM payments 
         WHERE company_id::text = $1`,
        [cid]
      ).catch(() => ({ rows: [{ today_revenue: 0, month_revenue: 0 }] })),

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
      ).catch(() => ({ rows: [{ total_invoices: 0, pending_amount: 0, overdue_count: 0 }] })),

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
           AND COALESCE(u.status, 'active') <> 'suspended'
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
      ).catch(() => ({ rows: [] })),

      // Pending leave requests
      pool.query(
        `SELECT COUNT(*) as pending_leaves 
         FROM leave_requests 
         WHERE company_id::text = $1 AND status = 'pending'`,
        [cid]
      ).catch(() => ({ rows: [{ pending_leaves: 0 }] })),

      // Approved leaves for today
      pool.query(
        `SELECT COUNT(*) as on_leave_count
         FROM leave_requests
         WHERE (company_id = $1 OR company_id::text = $1::text)
           AND status = 'approved'
           AND $2::date BETWEEN start_date AND end_date`,
        [cid, workDate]
      ).catch(() => ({ rows: [{ on_leave_count: 0 }] })),
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
        `SELECT id, title, status, priority, stage, created_at 
         FROM jobs 
         WHERE company_id::text = $2
           AND (assigned_employee_id::text = $1 OR employee_id::text = $1)
         ORDER BY created_at DESC LIMIT 10`,
        [uid, cid]
      ).catch(() => ({ rows: [] })),

      // Attendance history for this month
      pool.query(
        `SELECT date, check_in_time as clock_in, check_out_time as clock_out, check_in_time, check_out_time, status, working_hours, is_late 
         FROM attendance 
         WHERE user_id::text = $1 AND company_id::text = $2
           AND date >= date_trunc('month', $3::date)::date AND date <= $4::date
         ORDER BY date DESC LIMIT 10`,
        [uid, cid, workDate.slice(0, 7) + '-01', workDate]
      ).catch(() => ({ rows: [] })),

      // Employee's leave requests
      pool.query(
        `SELECT leave_type, start_date, end_date, status, reason 
         FROM leave_requests 
         WHERE user_id::text = $1 AND company_id::text = $2
         ORDER BY created_at DESC LIMIT 5`,
        [uid, cid]
      ).catch(() => ({ rows: [] })),

      // Employee's material requests
      pool.query(
        `SELECT item_name, quantity, status, urgency 
         FROM material_requests 
         WHERE requested_by::text = $1 AND company_id::text = $2
         ORDER BY created_at DESC LIMIT 5`,
        [uid, cid]
      ).catch(() => ({ rows: [] })),
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
      ).catch(() => ({ rows: [] })),

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
      ).catch(() => ({ rows: [] })),

      // Employee headcount by department
      pool.query(
        `SELECT department, COUNT(*) as count 
         FROM users 
         WHERE company_id::text = $1 AND role = 'employee'
           AND is_active = TRUE
           AND COALESCE(status, 'active') <> 'suspended'
         GROUP BY department`,
        [cid]
      ).catch(() => ({ rows: [] })),
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
      ).catch(() => ({ rows: [] })),

      pool.query(
        `SELECT id, invoice_number, total_amount, status, due_date 
         FROM invoices 
         WHERE company_id::text = $1 AND (customer_id::text = $2 OR customer_email = $3)
         ORDER BY created_at DESC LIMIT 10`,
        [cid, String(customerId || ""), String(email || "")]
      ).catch(() => ({ rows: [] })),
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
