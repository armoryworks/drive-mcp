/**
 * Error-wrapping utilities. The Google APIs throw errors with a lot of
 * machinery in them; the MCP client (and the LLM consuming the tool result)
 * is better served by short, structured, actionable messages.
 *
 * Pattern: every tool wraps its work in {@link wrapToolErrors}, which catches
 * thrown errors and converts them into a uniform error shape the MCP server
 * can surface as an isError tool response.
 */

export interface ToolErrorShape {
  /** Short error code for programmatic dispatch. */
  code: string;
  /** Human-readable message suitable for showing to the user. */
  message: string;
  /** Optional structured details for debugging. */
  details?: Record<string, unknown>;
}

/**
 * Best-effort extraction of a useful error message from whatever shape the
 * underlying API library threw. The googleapis client wraps Google API errors
 * in a particular structure; this normalizes them.
 */
export function describeError(err: unknown): ToolErrorShape {
  if (err instanceof Error) {
    // googleapis throws errors with a `response.data.error` shape
    const anyErr = err as unknown as {
      response?: { status?: number; data?: { error?: { message?: string; status?: string } } };
      code?: number | string;
      errors?: Array<{ message?: string; reason?: string }>;
    };

    const googleMessage = anyErr.response?.data?.error?.message;
    const googleStatus = anyErr.response?.data?.error?.status;
    const httpStatus = anyErr.response?.status;
    const errors = anyErr.errors;

    if (googleMessage) {
      return {
        code: googleStatus ?? `http_${httpStatus ?? 'unknown'}`,
        message: googleMessage,
        details: {
          httpStatus,
          googleStatus,
          ...(errors && errors.length > 0 ? { errors } : {}),
        },
      };
    }

    return {
      code: 'unknown_error',
      message: err.message,
      details: {
        name: err.name,
      },
    };
  }

  return {
    code: 'unknown_error',
    message: typeof err === 'string' ? err : 'An unknown error occurred',
  };
}

/**
 * Wrap a tool handler so any thrown error becomes a structured tool error
 * response rather than a transport-level failure. The MCP server presents
 * the formatted message back to the LLM, which can decide whether to retry
 * with different arguments or surface the error to the user.
 */
export async function wrapToolErrors<T>(
  toolName: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: ToolErrorShape }> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    const error = describeError(err);
    error.details = { ...error.details, tool: toolName };
    return { ok: false, error };
  }
}
