/**
 * Classification of errors thrown by routeChatCompletion into the response
 * kind the chat completions route answers with. Extracted as a pure helper
 * so the mapping can be pinned by tests (the route handler has no test
 * seam of its own).
 *
 * Order matters (bug hunt finding 3): the failover-budget error message
 * BEGINS with the generic aggregate prefix — "All upstreams failed to
 * process the request. Failover timed out after …" — so the aggregate
 * branch must yield when the error is also a timeout, or budget timeouts
 * are misreported as 502 Bad Gateway instead of 504. The aggregate check
 * used to be an exact string match, which let the budget message fall
 * through to the timeout branch; a later switch to startsWith captured
 * it. Client-abort detection keeps its precedence over the timeout
 * branch, as before.
 */
export type ChatErrorKind =
  | 'no-upstream'
  | 'all-upstreams-failed'
  | 'client-aborted'
  | 'timeout'
  | 'server-error';

export function classifyChatError(err: Error): ChatErrorKind {
  const msg = err.message || '';

  if (msg.startsWith('No upstream available for model:')) {
    return 'no-upstream';
  }

  const isTimeout = err.name === 'TimeoutError' || msg.includes('timed out');

  if (msg.startsWith('All upstreams failed to process the request.') && !isTimeout) {
    return 'all-upstreams-failed';
  }

  if (
    err.name === 'AbortError' ||
    msg.includes('Client aborted') ||
    msg.includes('client_closed_request')
  ) {
    return 'client-aborted';
  }

  if (isTimeout) {
    return 'timeout';
  }

  return 'server-error';
}
