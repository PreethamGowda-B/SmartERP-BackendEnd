const { pool } = require('../db');

/**
 * Generate unique company ID in format: SMR1001, SMR1002, SMR1003, etc.
 * Auto-increments from the last generated ID
 */
async function generateCompanyId() {
    try {
        // Get the highest existing company_id number
        const result = await pool.query(`
      SELECT company_id 
      FROM companies 
      WHERE company_id ~ '^SMR[0-9]+$'
      ORDER BY 
        CAST(SUBSTRING(company_id FROM 4) AS INTEGER) DESC 
      LIMIT 1
    `);

        let nextNumber = 1001; // Default starting number

        if (result.rows.length > 0) {
            const lastId = result.rows[0].company_id;
            const lastNumber = parseInt(lastId.substring(3)); // Extract number after 'SMR'
            nextNumber = lastNumber + 1;
        }

        const companyId = `SMR${nextNumber}`;

        console.log(`✅ Generated company ID: ${companyId}`);
        return companyId;
    } catch (err) {
        console.error('❌ Error generating company ID:', err);
        throw new Error('Failed to generate company ID');
    }
}

/**
 * Validate if a company code exists
 */
async function validateCompanyCode(companyCode) {
    try {
        const result = await pool.query(
            'SELECT id, company_id, company_name FROM companies WHERE company_id = $1',
            [companyCode]
        );

        if (result.rows.length > 0) {
            return {
                valid: true,
                company: result.rows[0]
            };
        }

        return {
            valid: false,
            company: null
        };
    } catch (err) {
        console.error('❌ Error validating company code:', err);
        return {
            valid: false,
            company: null
        };
    }
}

/**
 * Get company details by ID
 */
async function getCompanyById(companyId) {
    try {
        const result = await pool.query(
            'SELECT * FROM companies WHERE id = $1',
            [companyId]
        );

        return result.rows[0] || null;
    } catch (err) {
        console.error('❌ Error getting company:', err);
        return null;
    }
}

/**
 * Get company details by company code
 */
async function getCompanyByCode(companyCode) {
    try {
        const result = await pool.query(
            'SELECT * FROM companies WHERE company_id = $1',
            [companyCode]
        );

        return result.rows[0] || null;
    } catch (err) {
        console.error('❌ Error getting company by code:', err);
        return null;
    }
}

module.exports = {
    generateCompanyId,
    validateCompanyCode,
    getCompanyById,
    getCompanyByCode
};
