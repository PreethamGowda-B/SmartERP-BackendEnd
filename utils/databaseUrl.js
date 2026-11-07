'use strict';

/**
 * Validate a PostgreSQL URL without rewriting host, port, username, SSL mode,
 * or credentials. SmartERP uses session-scoped PostgreSQL state, so Supabase
 * transaction-mode endpoints cannot be used for application connections.
 */
function cleanConnectionString(url) {
  if (!url) return url;
  let parsed;
  try { parsed = new URL(url); } catch (_) { throw new Error('DATABASE_URL must be a valid PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');

  const host = parsed.hostname.toLowerCase();
  if (host.endsWith('.supabase.co') || host.endsWith('.pooler.supabase.com')) {
    const port = Number(parsed.port || (host.endsWith('.pooler.supabase.com') ? 6543 : 5432));
    if (parsed.searchParams.get('sslmode')?.toLowerCase() === 'disable') {
      throw new Error('Supabase DATABASE_URL must use SSL.');
    }
    if (port === 6543) throw new Error('Supabase URLs on port 6543 or using transaction pooling are incompatible; configure the dashboard-issued session/direct URL.');
    if (port !== 5432) throw new Error('Unsupported Supabase PostgreSQL port; configure the dashboard-issued session URL.');
    if (host.endsWith('.pooler.supabase.com') && !/^.+\.[a-z0-9]{20,}$/i.test(decodeURIComponent(parsed.username))) {
      throw new Error('Supabase shared session pooler URLs require the dashboard-issued role and project reference.');
    }
  }
  return url;
}

module.exports = { cleanConnectionString };
