'use strict';

const { pool } = require('../db');

async function recordCompanyStorageUsage(companyId, storageKey, fileSizeBytes, sourceType, client = pool) {
  const size = Number(fileSizeBytes);
  if (!companyId || !storageKey || !Number.isSafeInteger(size) || size <= 0) {
    throw new TypeError('Company storage usage requires a company, key, and positive byte size.');
  }
  await client.query(
    `INSERT INTO company_storage_usage(company_id, storage_key, file_size_bytes, source_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id, storage_key) DO UPDATE
       SET file_size_bytes = EXCLUDED.file_size_bytes,
           source_type = EXCLUDED.source_type,
           updated_at = NOW()`,
    [String(companyId), String(storageKey), size, String(sourceType)]
  );
}

async function removeCompanyStorageUsage(companyId, storageKey, client = pool) {
  if (!companyId || !storageKey) return;
  await client.query(
    'DELETE FROM company_storage_usage WHERE company_id = $1 AND storage_key = $2',
    [String(companyId), String(storageKey)]
  );
}

module.exports = { recordCompanyStorageUsage, removeCompanyStorageUsage };
