/**
 * Retry + logging helpers.
 *
 * Wraps tool handlers with automatic retry on transient errors (5xx, 429) and
 * structured logging gated by the LOG_LEVEL env var. The retry policy is
 * conservative — three attempts with exponential backoff — designed to soak
 * up flaky network and short-lived API hiccups without masking real bugs.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function envLogLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? 'warn').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' || raw === 'silent') {
    return raw;
  }
  return 'warn';
}

const ACTIVE_LEVEL = envLogLevel();

export function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[ACTIVE_LEVEL]) return;
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(fields ?? {}),
  };
  // MCP servers communicate over stdout via JSON-RPC; logs must go to stderr.
  process.stderr.write(JSON.stringify(payload) + '\n');
}

/**
 * Run an async function with automatic retry on transient errors. Transient
 * = HTTP 5xx or 429 (rate-limited). Other errors bubble up immediately.
 *
 * Default policy: up to 3 attempts, exponential backoff starting at 500ms,
 * capped at 5s, with 25% jitter.
 */
export async function withRetry<T>(
  toolName: string,
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitter?: number;
  } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 5_000;
  const jitter = opts.jitter ?? 0.25;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt === maxAttempts) {
        if (attempt > 1) {
          log('warn', 'tool_failed_after_retry', { tool: toolName, attempts: attempt });
        }
        throw err;
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jittered = delay * (1 + (Math.random() * 2 - 1) * jitter);
      log('debug', 'tool_retry', { tool: toolName, attempt, delay_ms: Math.round(jittered) });
      await new Promise((resolve) => setTimeout(resolve, jittered));
    }
  }
  throw lastErr;
}

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const anyErr = err as { response?: { status?: number }; code?: number | string };
  const status = anyErr.response?.status;
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
  }
  // Common transient network conditions
  const code = String(anyErr.code ?? '');
  if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code)) return true;
  return false;
}
