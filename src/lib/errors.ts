/**
 * Error-wrapping utilities. The Google APIs throw errors with a lot of
 * machinery in them; the MCP client (and the LLM consuming the tool result)
 * is better served by short, structured, actionable messages.
 *
 * Pattern: every tool wraps its work in {@link wrapToolErrors}, which catches
 * thrown errors and converts them into a uniform error shape the MCP server
 * can surface as an isError tool response. We also augment common Google API
 * error patterns with actionable hints so the LLM can self-correct.
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
      const hint = suggestionForGoogleError(httpStatus, googleStatus, googleMessage);
      return {
        code: googleStatus ?? 'http_' + (httpStatus ?? 'unknown'),
        message: hint ? googleMessage + ' — ' + hint : googleMessage,
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
 * Map common Google API error patterns to actionable hints. The LLM reads
 * these and can typically self-correct without bouncing back to the user.
 */
function suggestionForGoogleError(
  httpStatus: number | undefined,
  googleStatus: string | undefined,
  message: string,
): string | undefined {
  const lower = message.toLowerCase();

  if (httpStatus === 404 || googleStatus === 'NOT_FOUND') {
    if (lower.includes('file')) {
      return 'Check the file_id is correct and the file is not in the trash (use restore_file or set include_trashed=true on search_files).';
    }
    return 'The resource was not found. Verify the ID and your access rights.';
  }

  if (httpStatus === 403 || googleStatus === 'PERMISSION_DENIED') {
    if (lower.includes('cannot add children')) {
      return 'You lack permission to add files to this folder. Try creating in a folder you own, or use copy_file to a folder you control.';
    }
    if (lower.includes('insufficient permission') || lower.includes('insufficient permissions')) {
      return 'OAuth scope insufficient for this operation. The wrapper requires drive, documents, and spreadsheets scopes — re-run the auth CLI if scopes have changed.';
    }
    return 'Permission denied. Verify your account has edit access to this file.';
  }

  if (httpStatus === 429 || googleStatus === 'RESOURCE_EXHAUSTED') {
    return 'Rate limit exceeded. Wait 30-60 seconds and retry. For bulk operations, use the batch_* tools and consider spacing calls further apart.';
  }

  if (httpStatus === 401 || googleStatus === 'UNAUTHENTICATED') {
    return 'Authentication failed. Run the auth CLI to refresh tokens: npx -y -p @armoryworks/drive-mcp armoryworks-drive-mcp-auth';
  }

  if (httpStatus === 400 || googleStatus === 'INVALID_ARGUMENT' || googleStatus === 'FAILED_PRECONDITION') {
    if (lower.includes('invalid value') && lower.includes('mimetype')) {
      return 'The mimeType filter must exactly match the file type, e.g. application/vnd.google-apps.document for Google Docs.';
    }
    if (lower.includes('range') && (lower.includes('parse') || lower.includes('invalid'))) {
      return 'The A1-notation range looks malformed. Examples of valid ranges: "Sheet1!B7", "Sheet1!A1:C10", "A:A" for whole column.';
    }
    if (lower.includes('not found') && lower.includes('suggestion')) {
      return 'No suggestions found in the document. The document may have no pending tracked changes.';
    }
    return 'The request payload was rejected. Re-check the schema requirements for this tool.';
  }

  if (httpStatus !== undefined && httpStatus >= 500) {
    return 'Google API server error. This is usually transient; retry in a few seconds.';
  }

  return undefined;
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
