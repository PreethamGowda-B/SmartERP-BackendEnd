const { pool } = require('../db');

/**
 * Track a single field change in inventory history
 */
async function trackChange(itemId, action, fieldName, oldValue, newValue, userId, userName) {
    try {
        await pool.query(
            `INSERT INTO inventory_history 
       (inventory_item_id, action_type, field_name, old_value, new_value, changed_by, changed_by_name, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
            [itemId, action, fieldName, String(oldValue || ''), String(newValue || ''), userId, userName]
        );
    } catch (error) {
        console.error('Error tracking inventory change:', error);
        // Don't throw - history tracking shouldn't break the main operation
    }
}

/**
 * Track all changes between old and new item objects
 */
async function trackAllChanges(itemId, oldItem, newItem, userId, userName) {
    const fieldsToTrack = [
        'name', 'description', 'quantity', 'category', 'unit',
        'min_quantity', 'supplier_name', 'supplier_contact', 'supplier_email'
    ];

    for (const field of fieldsToTrack) {
        if (oldItem[field] !== newItem[field]) {
            await trackChange(
                itemId,
                'updated',
                field,
                oldItem[field],
                newItem[field],
                userId,
                userName
            );
        }
    }
}

/**
 * Get history for a specific inventory item
 */
async function getItemHistory(itemId) {
    try {
        const result = await pool.query(
            `SELECT * FROM inventory_history 
       WHERE inventory_item_id = $1 
       ORDER BY created_at DESC`,
            [itemId]
        );
        return result.rows;
    } catch (error) {
        console.error('Error fetching inventory history:', error);
        return [];
    }
}

/**
 * Track item creation
 */
async function trackCreation(itemId, itemData, userId, userName) {
    await trackChange(itemId, 'created', 'item', null, JSON.stringify(itemData), userId, userName);
}

/**
 * Track item deletion
 */
async function trackDeletion(itemId, userId, userName) {
    await trackChange(itemId, 'deleted', 'item', null, null, userId, userName);
}

/**
 * Track item restoration
 */
async function trackRestoration(itemId, userId, userName) {
    await trackChange(itemId, 'restored', 'item', null, null, userId, userName);
}

module.exports = {
    trackChange,
    trackAllChanges,
    getItemHistory,
    trackCreation,
    trackDeletion,
    trackRestoration
};
