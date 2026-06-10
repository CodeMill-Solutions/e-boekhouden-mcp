import { EboekhoudenClient } from '../eboekhouden-client.js';
import { ok, type ToolTextResult } from './result.js';

/**
 * Shared helpers for the gated write tools (create_purchase_mutation,
 * create_payment, create_money_spent, create_sales_invoice, create_relation).
 * Keeping the safety posture (env gate + dry-run) in one place means every write
 * tool behaves identically and a change is made once.
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

/** Standard refusal message when writes are disabled. */
export const WRITES_DISABLED_REASON =
  'Writes are disabled. Set EBOEKHOUDEN_ALLOW_WRITES=true in the server environment to enable booking.';

export interface GatedWriteOptions {
  /** When false/omitted, return a dry-run preview instead of writing. */
  confirm?: boolean;
  /** Result flag name: `written` (mutations/payments) or `created` (relations/invoices). */
  statusKey?: 'written' | 'created';
  /** Key under which the would-be request body is returned in preview responses. */
  plannedKey: string;
  /** Key under which the created resource is returned on success. */
  resultKey: string;
  /** The request body to preview / send. */
  body: Record<string, unknown>;
  /** Performs the actual write and returns the created resource. */
  execute: () => Promise<unknown>;
  /** Extra fields merged into every response (e.g. termOfPaymentSource). */
  extra?: Record<string, unknown>;
}

/**
 * Apply the two safety guards shared by every write tool:
 *   1. env gate — refuse unless EBOEKHOUDEN_ALLOW_WRITES is truthy;
 *   2. dry-run — only write when `confirm` is true, otherwise echo the body.
 * Build the request `body` before calling this; for tools that resolve values
 * over the network, gate that work on `writesEnabled()` so a blocked call does
 * no needless requests.
 */
export async function gatedWrite(opts: GatedWriteOptions): Promise<ToolTextResult> {
  const statusKey = opts.statusKey ?? 'written';
  const extra = opts.extra ?? {};

  if (!writesEnabled()) {
    return ok({ [statusKey]: false, blocked: true, reason: WRITES_DISABLED_REASON, ...extra, [opts.plannedKey]: opts.body });
  }
  if (!opts.confirm) {
    const verb = statusKey === 'created' ? 'created' : 'booked';
    return ok({
      [statusKey]: false,
      dryRun: true,
      message: `Dry-run: nothing was ${verb}. Re-run with confirm: true to proceed.`,
      ...extra,
      [opts.plannedKey]: opts.body,
    });
  }

  const result = await opts.execute();
  return ok({ [statusKey]: true, ...extra, [opts.resultKey]: result });
}

export type TermOfPaymentSource = 'explicit' | 'relation' | 'default' | 'eboekhouden-default';

/**
 * Resolve the payment term for an invoice: an explicit value wins; otherwise the
 * term configured on the relation; otherwise a caller-supplied default;
 * otherwise leave it to e-Boekhouden (undefined). The relation read endpoint
 * omits `termOfPayment` when it is empty, so an unset term falls through.
 */
export async function resolveTermOfPayment(
  client: EboekhoudenClient,
  administration: string | undefined,
  relationId: number,
  explicit: number | undefined,
  fallbackDefault: number | undefined,
): Promise<{ term: number | undefined; source: TermOfPaymentSource }> {
  if (explicit !== undefined) return { term: explicit, source: 'explicit' };
  const relation = await client.request<{ termOfPayment?: number }>({
    administration,
    path: `/relation/${relationId}`,
  });
  if (typeof relation?.termOfPayment === 'number') return { term: relation.termOfPayment, source: 'relation' };
  if (fallbackDefault !== undefined) return { term: fallbackDefault, source: 'default' };
  return { term: undefined, source: 'eboekhouden-default' };
}

/**
 * Resolve the single ledger of a given category (e.g. 'CRED' creditor, 'DEB'
 * debtor). Throws a clear error when there is not exactly one match so the
 * caller is told to pass the id explicitly.
 */
export async function resolveSingleLedger(
  client: EboekhoudenClient,
  administration: string | undefined,
  category: string,
  label: string,
): Promise<number> {
  const ledgers = await client.paginate<{ id: number }>('/ledger', { administration, query: { category } });
  if (ledgers.length === 1) return ledgers[0]!.id;
  throw new Error(
    `Could not auto-resolve the ${label} ledger (found ${ledgers.length} ${category} ledgers). ` +
      `Pass the ledger id explicitly.`,
  );
}
