/**
 * scripts/migrate_documents_to_cloud.js
 *
 * One-time migration script to move legacy local files from `uploads/documents/`
 * to Cloudinary and update `employee_documents.file_url` in database.
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { cloudinary, hasCloudinaryConfig } = require('../config/cloudinary');

async function migrateDocumentsToCloud() {
  console.log("=== STARTING DOCUMENT STORAGE CLOUD MIGRATION ===");

  if (!hasCloudinaryConfig) {
    console.error("❌ Cloudinary configuration missing. Migration aborted.");
    return;
  }

  const uploadDir = path.join(__dirname, '../uploads/documents');

  if (!fs.existsSync(uploadDir)) {
    console.log("ℹ️ Local uploads/documents directory does not exist or is empty. No files to migrate.");
    return;
  }

  const files = fs.readdirSync(uploadDir);
  console.log(`Found ${files.length} local document files in ${uploadDir}`);

  let migratedCount = 0;

  for (const filename of files) {
    const filePath = path.join(uploadDir, filename);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;

    console.log(`Migrating file: ${filename}...`);

    try {
      const isImage = /\.(jpg|jpeg|png)$/i.test(filename);
      const uploadResult = await cloudinary.uploader.upload(filePath, {
        folder: 'smarterp/documents/migrated',
        resource_type: isImage ? 'image' : 'raw',
        public_id: `migrated_${path.parse(filename).name}`,
      });

      const cloudUrl = uploadResult.secure_url;

      // Update database matching file_url containing local filename
      const updateRes = await pool.query(
        `UPDATE employee_documents
         SET file_url = $1
         WHERE file_url LIKE $2 OR file_url = $3
         RETURNING id`,
        [cloudUrl, `%${filename}%`, filename]
      );

      console.log(`  Uploaded to Cloudinary: ${cloudUrl} (DB rows updated: ${updateRes.rowCount})`);
      migratedCount++;
    } catch (err) {
      console.error(`❌ Failed to migrate ${filename}:`, err.message);
    }
  }

  console.log(`=== MIGRATION COMPLETE: ${migratedCount}/${files.length} files migrated to Cloudinary ===`);
}

if (require.main === module) {
  migrateDocumentsToCloud().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = migrateDocumentsToCloud;
