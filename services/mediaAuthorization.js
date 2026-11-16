'use strict';

function mediaUrlPattern(mediaId) {
  return `%/api/messages/media/${String(mediaId)}%`;
}

async function authorizeMedia({ pool, principal, mediaId }) {
  if (!mediaId || typeof mediaId !== 'string') return { allowed: false, status: 404 };

  const relationships = await pool.query(
    `SELECT 'employee_document' AS kind, d.company_id::text AS company_id, d.employee_id::text AS employee_id, NULL::text AS customer_id, NULL::text AS technician_id, NULL::text AS conversation_id
       FROM employee_documents d WHERE d.file_url LIKE $1
     UNION ALL
     SELECT 'staff_message', c.company_id::text, NULL::text, NULL::text, NULL::text, m.conversation_id::text
       FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.media_url LIKE $1
     UNION ALL
     SELECT 'job_message', j.company_id::text, NULL::text, j.customer_id::text, j.assigned_to::text, NULL::text
       FROM job_messages jm JOIN jobs j ON j.id = jm.job_id WHERE jm.media_url LIKE $1`,
    [mediaUrlPattern(mediaId)]
  );

  // Must match at least one verified database relationship (never authorize detached media)
  if (relationships.rows.length === 0) return { allowed: false, status: 404 };

  // Deny conflicting cross-company relationships (data integrity and isolation guard)
  const distinctCompanies = new Set(relationships.rows.map(r => r.company_id).filter(Boolean));
  if (distinctCompanies.size > 1) return { allowed: false, status: 404 };

  const isCustomer = principal.type === 'customer';
  const isSuperAdmin = principal.role === 'super_admin';

  // Super Admin possesses verified platform audit authority over valid platform relationships
  if (isSuperAdmin) {
    return { allowed: true, status: 200 };
  }

  // Tenant principal must match the relationship company
  const primaryCompany = relationships.rows[0].company_id;
  if (String(principal.companyId) !== String(primaryCompany)) {
    return { allowed: false, status: 404 };
  }

  // Authorize independently across all legitimate matching relationships
  for (const relationship of relationships.rows) {
    if (relationship.kind === 'employee_document') {
      if (!isCustomer && (['owner', 'admin'].includes(principal.role) || String(principal.userId) === String(relationship.employee_id))) {
        return { allowed: true, status: 200 };
      }
    } else if (relationship.kind === 'staff_message') {
      if (!isCustomer) {
        const membership = await pool.query(
          'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id::text = $2 LIMIT 1',
          [relationship.conversation_id, String(principal.userId)]
        );
        if (membership.rows.length === 1) return { allowed: true, status: 200 };
      }
    } else if (relationship.kind === 'job_message') {
      const allowed = isCustomer
        ? String(principal.customerId) === String(relationship.customer_id)
        : (['owner', 'admin'].includes(principal.role) || String(principal.userId) === String(relationship.technician_id));
      if (allowed) return { allowed: true, status: 200 };
    }
  }

  return { allowed: false, status: 404 };
}

module.exports = { authorizeMedia };

