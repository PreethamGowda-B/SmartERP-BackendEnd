'use strict';

const DEFAULT_THRESHOLD = 16;
const DEFAULT_WINDOW_MINUTES = 15;

function readBoundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function getPromptInjectionPolicy(env = process.env) {
  return {
    threshold: readBoundedInteger(env.AI_PROMPT_INJECTION_THRESHOLD, DEFAULT_THRESHOLD, 2, 1000),
    windowMinutes: readBoundedInteger(env.AI_PROMPT_INJECTION_WINDOW_MINUTES, DEFAULT_WINDOW_MINUTES, 1, 1440),
    autoSuspendEnabled: String(env.AI_PROMPT_INJECTION_AUTO_SUSPEND_ENABLED || '').toLowerCase() === 'true',
  };
}

function canExecuteAutomaticPromptSuspension({ action, details, env = process.env }) {
  const policy = getPromptInjectionPolicy(env);
  return action?.is_automated === true
    && details?.policyRule === 'RULE_PROMPT_INJECTION_AUTO_SUSPEND'
    && details?.autoSuspensionEnabled === true
    && policy.autoSuspendEnabled === true
    && Number(details?.verifiedPromptAttemptCount) >= policy.threshold
    && Number(details?.detectionWindowMinutes) === policy.windowMinutes
    && Boolean(details?.userId)
    && Boolean(details?.companyId);
}

module.exports = { DEFAULT_THRESHOLD, DEFAULT_WINDOW_MINUTES, getPromptInjectionPolicy, canExecuteAutomaticPromptSuspension };
