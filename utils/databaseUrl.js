'use strict';

/**
 * Validate a PostgreSQL URL and adapt Supabase's shared transaction pooler
 * endpoint to its session endpoint. The application also scopes RLS state and
 * locks to explicit transactions, which supports dedicated transaction poolers.
 */
function cleanConnectionString(url) {
  if (!url) return url;
  let parsed;
  try { parsed = new URL(url); } catch (_) { throw new Error('DATABASE_URL must be a valid PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');

  const host = parsed.hostname.toLowerCase();
  let rewritten = false;
  if (host.endsWith('.supabase.co') || host.endsWith('.pooler.supabase.com')) {
    let port = Number(parsed.port || (host.endsWith('.pooler.supabase.com') ? 6543 : 5432));
    if (parsed.searchParams.get('sslmode')?.toLowerCase() === 'disable') {
      throw new Error('Supabase DATABASE_URL must use SSL.');
    }
    if (port === 6543 && host.endsWith('.pooler.supabase.com')) {
      // Supavisor's shared pooler serves transaction mode on 6543 and session
      // mode on 5432. Keep the dashboard-provided host, user and secret intact.
      parsed.port = '5432';
      port = 5432;
      rewritten = true;
    }
    if (port !== 5432 && port !== 6543) throw new Error('Unsupported Supabase PostgreSQL port.');
    if (host.endsWith('.pooler.supabase.com') && !/^.+\.[a-z0-9]{20,}$/i.test(decodeURIComponent(parsed.username))) {
      throw new Error('Supabase shared session pooler URLs require the dashboard-issued role and project reference.');
    }
  }
  return rewritten ? parsed.href : url;
}

module.exports = { cleanConnectionString };
