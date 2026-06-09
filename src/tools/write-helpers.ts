/**
 * Shared helpers for the gated write tools (create_purchase_mutation,
 * create_relation, …). Keeping these in one place keeps the safety posture
 * (env gate) and body shaping consistent across every write tool.
 */

/**
 * Whether write operations are permitted. Writes are refused unless
 * `EBOEKHOUDEN_ALLOW_WRITES` is set to a truthy value, so the default posture
 * stays read-only even though the write tools are registered.
 */
export function writesEnabled(): boolean {
  const v = (process.env['EBOEKHOUDEN_ALLOW_WRITES'] ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/** Drop undefined values so we send a clean JSON body. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Standard refusal payload when writes are disabled. */
export const WRITES_DISABLED_REASON =
  'Writes are disabled. Set EBOEKHOUDEN_ALLOW_WRITES=true in the server environment to enable booking.';
