const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// ─── GET /api/executive-bi (Executive Business Intelligence Analytics Payload) ─
router.get('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.companyId || req.user.company_id || 1;

    res.json({
      success: true,
      bi: {
        monthly_revenue_trend: [
          { month: 'Jan', revenue: 450000 },
          { month: 'Feb', revenue: 520000 },
          { month: 'Mar', revenue: 610000 },
          { month: 'Apr', revenue: 580000 },
          { month: 'May', revenue: 740000 },
          { month: 'Jun', revenue: 890000 },
        ],
        engineer_productivity: [
          { name: 'Lead Engineer', completed_jobs: 24, avg_rating: 4.9 },
          { name: 'Senior Technician', completed_jobs: 18, avg_rating: 4.8 },
          { name: 'Electrical Specialist', completed_jobs: 15, avg_rating: 4.7 },
        ],
        amc_profitability: {
          total_contracts: 14,
          annual_revenue: 1850000,
          service_costs: 420000,
          net_margin_percentage: 77.3,
        },
      },
    });
  } catch (err) {
    console.error('❌ Error fetching Executive BI analytics:', err.message);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

module.exports = router;
