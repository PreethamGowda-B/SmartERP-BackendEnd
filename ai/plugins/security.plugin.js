/**
 * ai/plugins/security.plugin.js
 *
 * Read-Only Security Investigation Plugin for SmartERP AI.
 * Provides narrowly scoped, 100% read-only data accessor tools for the
 * Gemini Security Analyst Specialist.
 *
 * STRICT SECURITY CONSTRAINTS:
 * - Read-Only (SELECT queries only).
 * - Zero terminal / shell execution.
 * - Zero write, update, delete, or drop queries.
 * - Zero access to passwords, tokens, or JWT signing secrets.
 * - Restricted exclusively to 'super_admin' role context.
 */

const BasePlugin = require('./base.plugin');
const { pool } = require('../../db');
const { redactSensitiveData } = require('../../utils/promptShield');

class SecurityPlugin extends BasePlugin {
  constructor() {
    super('SecurityPlugin', 'security');

    this.tools = {
      get_incident_details: {
        name: 'get_incident_details',
        description: 'Retrieves the complete record and deterministic evidence for a security incident.',
        parameters: {
          type: 'object',
          properties: {
            incidentId: {
              type: 'string',
              description: 'The UUID of the security incident to investigate',
            },
          },
          required: ['incidentId'],
        },
        allowedRoles: ['super_admin'],
        isDestructive: false,
        execute: async (params) => {
          const res = await pool.query(
            `SELECT id, company_id, title, threat_category, status, severity, risk_score, source_ip, target_user_id, event_count, first_seen_at, last_seen_at, ai_analysis, created_at 
             FROM security_incidents WHERE id = $1`,
            [params.incidentId]
          );
          if (res.rows.length === 0) {
            return { error: 'INCIDENT_NOT_FOUND', message: `Incident ${params.incidentId} does not exist.` };
          }
          return redactSensitiveData(res.rows[0]);
        },
      },

      get_correlated_events: {
        name: 'get_correlated_events',
        description: 'Fetches raw telemetry events correlated with a security incident.',
        parameters: {
          type: 'object',
          properties: {
            incidentId: {
              type: 'string',
              description: 'The UUID of the security incident',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of telemetry events to retrieve (default: 20, max: 50)',
            },
          },
          required: ['incidentId'],
        },
        allowedRoles: ['super_admin'],
        isDestructive: false,
        execute: async (params) => {
          const limit = Math.min(50, Math.max(1, params.limit || 20));

          // 1. Get incident details to find source IP and time window
          const incRes = await pool.query(
            'SELECT source_ip, target_user_id, company_id, ai_analysis, first_seen_at FROM security_incidents WHERE id = $1',
            [params.incidentId]
          );
          if (incRes.rows.length === 0) {
            return { error: 'INCIDENT_NOT_FOUND', message: 'Incident not found' };
          }
          const inc = incRes.rows[0];

          // 2. Fetch correlated events
          const eventsRes = await pool.query(
            `SELECT id, company_id, user_id, event_type, severity, ip_address, endpoint, http_method, status_code, metadata, created_at
             FROM security_events
             WHERE (
               ($1::varchar IS NOT NULL AND ip_address = $1)
               OR ($2::varchar IS NOT NULL AND user_id = $2)
             )
             ORDER BY created_at DESC
             LIMIT $3`,
            [inc.source_ip, inc.target_user_id, limit]
          );

          return {
            incidentId: params.incidentId,
            totalRetrieved: eventsRes.rows.length,
            events: redactSensitiveData(eventsRes.rows),
          };
        },
      },

      get_ip_threat_history: {
        name: 'get_ip_threat_history',
        description: 'Checks historical incidents and telemetry patterns originating from an IP address.',
        parameters: {
          type: 'object',
          properties: {
            ipAddress: {
              type: 'string',
              description: 'The IPv4 or IPv6 address to look up',
            },
            limit: {
              type: 'number',
              description: 'Max history entries (default: 10, max: 30)',
            },
          },
          required: ['ipAddress'],
        },
        allowedRoles: ['super_admin'],
        isDestructive: false,
        execute: async (params) => {
          const limit = Math.min(30, Math.max(1, params.limit || 10));
          const incRes = await pool.query(
            `SELECT id, title, threat_category, status, severity, risk_score, event_count, created_at
             FROM security_incidents
             WHERE source_ip = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [params.ipAddress, limit]
          );

          const eventStatsRes = await pool.query(
            `SELECT event_type, COUNT(*) as count
             FROM security_events
             WHERE ip_address = $1
             GROUP BY event_type`,
            [params.ipAddress]
          );

          return {
            ipAddress: params.ipAddress,
            historicalIncidents: incRes.rows,
            eventSummary: eventStatsRes.rows,
          };
        },
      },

      get_user_threat_history: {
        name: 'get_user_threat_history',
        description: 'Checks security event history and authentication anomalies associated with a user ID.',
        parameters: {
          type: 'object',
          properties: {
            userId: {
              type: 'string',
              description: 'The user UUID to look up',
            },
            limit: {
              type: 'number',
              description: 'Max records to fetch (default: 10, max: 30)',
            },
          },
          required: ['userId'],
        },
        allowedRoles: ['super_admin'],
        isDestructive: false,
        execute: async (params) => {
          const limit = Math.min(30, Math.max(1, params.limit || 10));
          const res = await pool.query(
            `SELECT id, event_type, severity, endpoint, http_method, status_code, metadata, created_at
             FROM security_events
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [params.userId, limit]
          );
          return {
            userId: params.userId,
            events: redactSensitiveData(res.rows),
          };
        },
      },

      get_company_security_summary: {
        name: 'get_company_security_summary',
        description: 'Retrieves high-level security posture and incident counts for a specific company.',
        parameters: {
          type: 'object',
          properties: {
            companyId: {
              type: 'string',
              description: 'The company ID to query',
            },
          },
          required: ['companyId'],
        },
        allowedRoles: ['super_admin'],
        isDestructive: false,
        execute: async (params) => {
          const res = await pool.query(
            `SELECT 
               COUNT(*) as total_incidents,
               COUNT(*) FILTER (WHERE status = 'open') as open_incidents,
               COUNT(*) FILTER (WHERE severity = 'critical') as critical_incidents,
               MAX(risk_score) as highest_risk_score
             FROM security_incidents
             WHERE company_id = $1`,
            [params.companyId]
          );
          return {
            companyId: params.companyId,
            summary: res.rows[0] || {},
          };
        },
      },
    };
  }
}

module.exports = SecurityPlugin;
