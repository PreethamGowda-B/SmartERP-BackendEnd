'use strict';

const PLUGINS_BY_AI_SCOPE = Object.freeze({
  cnc: Object.freeze(['CncPlugin', 'InventoryPlugin', 'JobsPlugin', 'NavigationPlugin']),
  finance: Object.freeze(['FinancialPlugin', 'GSTReconciliationPlugin', 'LiveSummaryPlugin', 'NavigationPlugin']),
  inventory: Object.freeze(['InventoryPlugin', 'CncPlugin', 'NavigationPlugin']),
  attendance: Object.freeze(['AttendancePlugin', 'LiveSummaryPlugin', 'NavigationPlugin']),
  payroll: Object.freeze(['PayrollPlugin', 'AttendancePlugin', 'EmployeePlugin', 'LiveSummaryPlugin', 'NavigationPlugin']),
  hr: Object.freeze(['EmployeePlugin', 'AttendancePlugin', 'PayrollPlugin', 'LiveSummaryPlugin', 'JobsPlugin', 'NavigationPlugin']),
  gst: Object.freeze(['GSTReconciliationPlugin', 'FinancialPlugin', 'NavigationPlugin']),
  executive: Object.freeze([
    'LiveSummaryPlugin', 'FinancialPlugin', 'GSTReconciliationPlugin', 'PayrollPlugin',
    'AttendancePlugin', 'InventoryPlugin', 'JobsPlugin', 'EmployeePlugin', 'CustomerPlugin',
    'NavigationPlugin',
  ]),
  security: Object.freeze(['SecurityPlugin']),
});

function isPluginAllowedForAiScope(scope, pluginName) {
  const normalizedScope = String(scope || 'general').toLowerCase();
  // Platform security tools are not exposed through the general business agent.
  if (normalizedScope === 'general') return pluginName !== 'SecurityPlugin';
  const allowedPlugins = PLUGINS_BY_AI_SCOPE[normalizedScope];
  return Array.isArray(allowedPlugins) && allowedPlugins.includes(pluginName);
}

module.exports = { PLUGINS_BY_AI_SCOPE, isPluginAllowedForAiScope };
