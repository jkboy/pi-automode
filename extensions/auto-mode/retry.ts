import { setTimeout as sleep } from "node:timers/promises";

/**
 * Blacklist-inverted retry policy for classifier completions: deterministic
 * failures (auth, billing/quota, invalid requests) fail closed immediately,
 * while everything else (network errors, timeouts, 5xx, stream failures) is
 * worth retrying. Proxy-gateway error strings vary too much for an allowlist.
 */
const NON_RETRYABLE_CLASSIFIER_ERRORS = new RegExp(
  [
    // Quota / billing exhaustion
    "GoUsageLimitError",
    "FreeUsageLimitError",
    "monthly usage limit",
    "available balance",
    "insufficient_quota",
    "out of budget",
    "quota exceeded",
    "billing",
    // Auth / permission
    "\\b401\\b",
    "\\b403\\b",
    "unauthorized",
    "forbidden",
    "invalid.?api.?key",
    "no api key",
    "authentication.?error",
    "permission.?denied",
    "permission_error",
    // Deterministic invalid requests
    "\\b400\\b",
    "\\b404\\b",
    "invalid_request_error",
    "not_found_error",
    "unsupported.?parameter",
    "不支持", // "unsupported" rejections from Chinese-language proxy gateways
  ].join("|"),
  "i",
);

/** True when the error is deterministic and retrying would only waste backoff time. */
export function isNonRetryableClassifierError(message: string): boolean {
  return NON_RETRYABLE_CLASSIFIER_ERRORS.test(message);
}

/** Exponential backoff: baseDelayMs after the first failure, doubling per additional failure. */
export function classifierRetryDelayMs(
  failureCount: number,
  baseDelayMs: number,
): number {
  return baseDelayMs * 2 ** Math.max(0, failureCount - 1);
}

/** Resolve true when the delay elapses, false when the signal aborts first. */
export async function waitForClassifierRetry(
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  if (ms <= 0) return true;
  try {
    await sleep(ms, undefined, { signal });
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return false;
    throw error;
  }
}
