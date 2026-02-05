-- Quick check: Let's see what's actually in the material_requests table
SELECT 
    id,
    item_name,
    requested_by,
    requested_by_name,
    status,
    created_at
FROM material_requests
ORDER BY created_at DESC
LIMIT 10;

-- Also check the data type of requested_by column
SELECT 
    column_name, 
    data_type,
    udt_name
FROM information_schema.columns 
WHERE table_name = 'material_requests' 
AND column_name IN ('requested_by', 'reviewed_by');
