import type { AdapterExecutionErrorFamily } from '../paperclip-types.js';

export function mapEluvixErrorToPaperclipFamily(
  status: number,
  code?: string,
  message?: string
): {
  errorFamily: AdapterExecutionErrorFamily;
  retryNotBefore?: string;
} {
  const lowerCode = (code || '').toLowerCase();
  const lowerMsg = (message || '').toLowerCase();

  if (status === 429 || lowerCode === 'rate_limit_exceeded' || lowerCode === 'budget-exceeded') {
    return {
      errorFamily: 'provider_quota',
      retryNotBefore: new Date(Date.now() + 60_000).toISOString(),
    };
  }
  if (status === 401 || status === 403) {
    return { errorFamily: 'auth_required' };
  }
  if (
    lowerCode.includes('guard') ||
    lowerCode.includes('dlp') ||
    lowerMsg.includes('prompt guard') ||
    lowerMsg.includes('output guard')
  ) {
    return { errorFamily: 'model_refusal' };
  }
  if (status >= 500 || lowerCode.includes('circuit') || lowerMsg.includes('upstream')) {
    return {
      errorFamily: 'transient_upstream',
      retryNotBefore: new Date(Date.now() + 15_000).toISOString(),
    };
  }
  return { errorFamily: 'invalid_request' };
}
