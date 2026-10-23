'use strict';

function getAiErrorResponse(error) {
  if (error?.code === 'AI_PROVIDER_NOT_CONFIGURED') {
    return { status: 503, body: { code: error.code, error: 'SmartERP AI is not configured on the server. Please contact your administrator.' } };
  }
  if (String(error?.code || '').startsWith('AI_PROVIDER_')) {
    return { status: 503, body: { code: 'AI_PROVIDER_UNAVAILABLE', error: 'SmartERP AI provider is temporarily unavailable. Please retry shortly.' } };
  }
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT' || error?.code === 'AI_REQUEST_TIMEOUT') {
    return { status: 504, body: { code: 'AI_REQUEST_TIMEOUT', error: 'The AI request timed out. Your session is still available; please retry.' } };
  }

  const code = String(error?.code || '');
  if (/^(08|23|42|53|57|58)[0-9A-Z]{3}$/.test(code) || ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH'].includes(code)) {
    return { status: 503, body: { code: 'AI_DATA_UNAVAILABLE', error: 'SmartERP could not retrieve the authorized business data needed for this request. No result was returned; please retry shortly.' } };
  }

  if (error?.code === 'AI_TOOL_EXECUTION_FAILED') {
    return { status: 503, body: { code: error.code, error: 'A required SmartERP data action could not be completed. No successful result was returned.' } };
  }
  if (error?.code === 'AI_TOOL_ARGUMENTS_INVALID') {
    return { status: 502, body: { code: error.code, error: 'The AI returned an invalid action request. No tool was executed; please rephrase your request.' } };
  }
  if (error?.code === 'AI_TOOL_SCOPE_DENIED') {
    return { status: 502, body: { code: error.code, error: 'The selected SmartERP assistant requested an unsupported action. No tool was executed; please try a more specific request.' } };
  }
  if (error?.code === 'AI_WORKFLOW_NOT_IMPLEMENTED') {
    return { status: 501, body: { code: error.code, error: 'This AI workflow is not connected to an approved execution path. No business records were changed.' } };
  }
  if (error?.code === 'AI_EMPTY_RESPONSE') {
    return { status: 503, body: { code: error.code, error: 'The AI returned an empty response. No result was reported; please try again.' } };
  }
  if (error?.code === 'AI_AGENT_ITERATION_LIMIT') {
    return { status: 503, body: { code: error.code, error: 'SmartERP could not complete this request within its safe execution limit. Please narrow the request and try again.' } };
  }
  return { status: 500, body: { code: 'AI_AGENT_FAILED', error: 'SmartERP AI could not complete this request. Please retry shortly.' } };
}

module.exports = { getAiErrorResponse };
