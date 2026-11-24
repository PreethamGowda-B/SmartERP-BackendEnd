const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('Document Security (SEC-05) verification', async (t) => {
    const documentsSource = fs.readFileSync(path.join(__dirname, '../routes/documents.js'), 'utf8');
    const inventorySource = fs.readFileSync(path.join(__dirname, '../routes/inventory.js'), 'utf8');

    await t.test('documents.js uses unguessable crypto.randomUUID() for public_id', () => {
        assert.ok(
            documentsSource.includes('public_id: `doc_${crypto.randomUUID()}`'),
            'documents.js should use crypto.randomUUID() for Cloudinary public_id'
        );
        assert.ok(
            !documentsSource.includes('public_id: `doc_${Date.now()}`'),
            'documents.js must not use predictable Date.now() for public_id'
        );
    });

    await t.test('inventory.js uses unguessable crypto.randomUUID() for public_id', () => {
        assert.ok(
            inventorySource.includes('public_id: `inv_${crypto.randomUUID()}`'),
            'inventory.js should use crypto.randomUUID() for Cloudinary public_id'
        );
        assert.ok(
            !inventorySource.includes('public_id: `inv_${Date.now()}`'),
            'inventory.js must not use predictable Date.now() for public_id'
        );
    });

    await t.test('documents.js implements authorized /:id/download route with tenant and role isolation', () => {
        assert.ok(
            documentsSource.includes("router.get('/:id/download'"),
            'documents.js must define GET /:id/download'
        );
        assert.ok(
            documentsSource.includes('WHERE d.id = $1 AND d.company_id = $2'),
            'Document download must scope query to company_id'
        );
        assert.ok(
            documentsSource.includes("role !== 'owner' && role !== 'admin'"),
            'Document download must verify role authorization'
        );
        assert.ok(
            documentsSource.includes('String(doc.employee_id) !== String(userId)'),
            'Non-admin employees must only access their own documents'
        );
    });

    await t.test('documents.js DELETE route enforces company_id scoping', () => {
        assert.ok(
            documentsSource.includes('DELETE FROM employee_documents WHERE id = $1 AND company_id = $2'),
            'Document delete query must enforce company_id scoping'
        );
    });
});
