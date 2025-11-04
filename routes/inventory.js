const express = require('express');
const router = express.Router();
const pool = require('../db'); // adjust if db.js exports differently
const { authenticateToken } = require('../middleware/authMiddleware');


// Add a new inventory item (employee)
router.post('/', authenticateToken, async (req, res) => {
try {
const { name, category, quantity, description } = req.body;
const employeeId = req.user?.id;
const officeId = req.user?.office_id;


const result = await pool.query(
'INSERT INTO inventory (office_id, employee_id, name, category, quantity, description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
[officeId, employeeId, name, category, quantity || 0, description || null]
);


res.json(result.rows[0]);
} catch (err) {
console.error('inventory POST error', err);
res.status(500).json({ error: 'Failed to add inventory item' });
}
});


// List inventory (Owner → all, Employee → their office only)
router.get('/', authenticateToken, async (req, res) => {
try {
const user = req.user;
let query, params = [];


if (user?.role === 'owner') {
query = `SELECT i.*, e.name AS employee_name, o.name AS office_name
FROM inventory i
LEFT JOIN employees e ON e.id = i.employee_id
LEFT JOIN offices o ON o.id = i.office_id
ORDER BY i.created_at DESC`;
} else {
query = 'SELECT * FROM inventory WHERE office_id = $1 ORDER BY created_at DESC';
params = [user.office_id];
}


const result = await pool.query(query, params);
res.json(result.rows);
} catch (err) {
console.error('inventory GET error', err);
res.status(500).json({ error: 'Failed to fetch inventory' });
}
});


module.exports = router;