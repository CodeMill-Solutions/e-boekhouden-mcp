/**
 * Shared helpers for shaping MCP tool results consistently across all tools.
 *
 * Every tool returns a single JSON text block. Successful calls include
 * `success: true` plus the payload; failures set `isError` and a `success:
 * false` + `error` body so agents can branch on it without parsing prose.
 */

export interface ToolTextResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  /** Index signature required by the MCP SDK's tool-result type. */
  [key: string]: unknown;
}

/** Wrap a successful payload as a pretty-printed JSON text result. */
export function ok(payload: Record<string, unknown>): ToolTextResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: true, ...payload }, null, 2) }],
  };
}

/** Wrap an error as a JSON text result flagged with `isError`. */
export function fail(error: unknown, extra?: Record<string, unknown>): ToolTextResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: false, error: message, ...extra }, null, 2) }],
    isError: true,
  };
}

/**
 * Run a tool handler body, converting any thrown error into a `fail()` result.
 * Keeps each tool's happy path uncluttered by try/catch boilerplate.
 */
export async function guard(fn: () => Promise<ToolTextResult>): Promise<ToolTextResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(err);
  }
}
