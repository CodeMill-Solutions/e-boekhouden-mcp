import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EboekhoudenClient } from '../eboekhouden-client.js';
import { guard } from './result.js';
import { compact, gatedWrite, targetAdministration, writesEnabled } from './write-helpers.js';

/**
 * Register ledger (grootboekrekening) write tools.
 *
 * Same two safety layers as the other write tools:
 *   1. Environment gate — refused unless EBOEKHOUDEN_ALLOW_WRITES is truthy.
 *   2. Dry-run by default — only creates when `confirm: true` is passed.
 *
 * Endpoint: POST /v1/ledger. Requires `code` and `description`; `category` and
 * `group` are optional. Note that POST/PATCH accept only five of the categories
 * `get_ledgers` can return: BAL, VW, FIN, DEB and CRED — the VAT categories
 * (AF6, AF19, AFOVERIG, VOOR, BTWRC, AF) are read-only and yield LEDG_018.
 *
 * The API does have PATCH /v1/ledger/{id} for corrections (not exposed as a
 * tool yet — and the category of a ledger with booked mutations can no longer
 * be changed freely, LEDG_014/LEDG_015). There is no DELETE, so a ledger can
 * never be removed through the API.
 */

/** The only categories POST/PATCH /v1/ledger accept (LEDG_018 for the others). */
const CREATABLE_CATEGORIES = ['BAL', 'VW', 'FIN', 'DEB', 'CRED'] as const;
type CreatableCategory = (typeof CREATABLE_CATEGORIES)[number];

/** Applied when the caller omits `category`; reported as `categorySource`. */
const DEFAULT_CATEGORY: CreatableCategory = 'VW';

/**
 * Warn when a new DEB/CRED ledger would break the single-ledger auto-resolution
 * that `create_payment` and `create_sales_invoice` rely on. Best-effort: the
 * lookup is skipped when writes are disabled (a blocked call should do no
 * needless requests) and a failed lookup still yields the generic warning.
 */
async function counterAccountWarning(
  client: EboekhoudenClient,
  administration: string | undefined,
  category: CreatableCategory,
): Promise<string | undefined> {
  if (category !== 'DEB' && category !== 'CRED') return undefined;
  const label = category === 'DEB' ? 'debtor' : 'creditor';

  let existing = '';
  if (writesEnabled()) {
    try {
      const ledgers = await client.paginate<{ id: number; code?: string; description?: string }>('/ledger', {
        administration,
        query: { category },
      });
      if (ledgers.length > 0) {
        const listed = ledgers.map((l) => `${l.code ?? '?'} ${l.description ?? ''} (id ${l.id})`.trim()).join(', ');
        const plural = ledgers.length === 1 ? 'ledger' : 'ledgers';
        existing = ` This administration already has ${ledgers.length} ${category} ${plural}: ${listed}.`;
      }
    } catch {
      // Best-effort enrichment only — never fail the preview over it.
    }
  }

  return (
    `Adding a ${category} ledger affects the automatic ${label} counter-account lookup: ` +
    `create_payment and create_sales_invoice resolve it only when exactly one ${category} ledger exists. ` +
    `With a second one those calls fail (dry-runs included) until the id is passed explicitly ` +
    `(\`contraLedgerId\` on create_payment, \`debtorLedgerId\` on create_sales_invoice).${existing}`
  );
}

export function registerLedgerWriteTools(server: McpServer, client: EboekhoudenClient): void {
  server.registerTool(
    'create_ledger',
    {
      description:
        'Create a general-ledger account (grootboekrekening) via POST /v1/ledger. ' +
        'WRITE TOOL — disabled unless the server has EBOEKHOUDEN_ALLOW_WRITES=true. ' +
        'Dry-run by default: it only creates when `confirm: true` is passed; otherwise it ' +
        'returns the exact body it would send so you can review it first. ' +
        'Required: `code` (max 10 chars; must be unused — LEDG_013 — and must not collide with an ' +
        'existing group code, LEDG_017) and `description` (max 100 chars). ' +
        '`category` must be BAL (balance sheet), VW (profit & loss), FIN (bank/cash), DEB (debtors) ' +
        'or CRED (creditors); the VAT categories `get_ledgers` also returns (AF6, AF19, AFOVERIG, ' +
        'VOOR, BTWRC, AF) are read-only and rejected here (LEDG_018). It defaults to "VW" when ' +
        'omitted — BAL vs VW decides balance-sheet vs P&L placement, so set it explicitly when in ' +
        'doubt; the response reports `categorySource` (`explicit`/`default`) either way. ' +
        '`group` (max 50 chars) must be an EXISTING ledger group — an unknown group returns LEDG_012. ' +
        'Creating a second DEB or CRED ledger breaks the automatic counter-account lookup in ' +
        '`create_payment` / `create_sales_invoice`; the response warns when that applies. ' +
        'On success the API returns only the new id (`{ "id": ... }`) — use `get_ledger` for the full ' +
        'record. That id can be used directly in `create_purchase_mutation` / `create_money_spent` / ' +
        '`create_sales_invoice`. Corrections afterwards go through PATCH /v1/ledger/{id}, which this ' +
        'server does not expose yet — so fix mistakes in the e-Boekhouden web UI. There is no DELETE ' +
        'endpoint at all: a ledger can never be removed via the API.',
      inputSchema: {
        code: z.string().min(1).max(10).describe('Ledger code, e.g. "4200" (max 10 chars, must not exist yet).'),
        description: z.string().min(1).max(100).describe('Ledger description, e.g. "Huisvestingskosten".'),
        category: z
          .enum(CREATABLE_CATEGORIES)
          .optional()
          .describe(
            'BAL (balance sheet), VW (profit & loss), FIN (bank/cash), DEB (debtors) or CRED (creditors). ' +
              'Defaults to "VW". VAT categories (AF6/AF19/AFOVERIG/VOOR/BTWRC/AF) cannot be created.',
          ),
        group: z
          .string()
          .min(1)
          .max(50)
          .optional()
          .describe('Code of an EXISTING ledger group (max 50 chars); an unknown group fails with LEDG_012.'),
        confirm: z
          .boolean()
          .optional()
          .describe('Set true to actually create. When false/omitted, returns a dry-run preview only.'),
        administration: z
          .string()
          .optional()
          .describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
      },
    },
    async ({ code, description, category, group, confirm, administration }) =>
      guard(async () => {
        const resolvedCategory = category ?? DEFAULT_CATEGORY;
        const body = compact({ code, description, category: resolvedCategory, group });

        const extra: Record<string, unknown> = {
          categorySource: category ? 'explicit' : `default (${DEFAULT_CATEGORY})`,
        };
        const warning = await counterAccountWarning(client, administration, resolvedCategory);
        if (warning) extra['warning'] = warning;

        return gatedWrite({
          confirm,
          statusKey: 'created',
          plannedKey: 'plannedLedger',
          resultKey: 'ledger',
          administration: targetAdministration(client, administration),
          body,
          extra,
          execute: () => client.request({ administration, method: 'POST', path: '/ledger', body }),
        });
      }),
  );
}
