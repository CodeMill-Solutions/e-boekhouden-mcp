import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EboekhoudenClient } from '../eboekhouden-client.js';
import { guard } from './result.js';
import { compact, gatedWrite } from './write-helpers.js';

/**
 * Register ledger (grootboekrekening) write tools.
 *
 * Same two safety layers as the other write tools:
 *   1. Environment gate — refused unless EBOEKHOUDEN_ALLOW_WRITES is truthy.
 *   2. Dry-run by default — only creates when `confirm: true` is passed.
 *
 * Endpoint: POST /v1/ledger. Requires `code` and `description`; `category`
 * (BAL/VW/FIN/DEB/CRED/…) and `group` are optional. There is no PATCH/DELETE
 * for ledgers via this API — once created, edit/remove via the web UI.
 */
export function registerLedgerWriteTools(server: McpServer, client: EboekhoudenClient): void {
  server.registerTool(
    'create_ledger',
    {
      description:
        'Create a general-ledger account (grootboekrekening) via POST /v1/ledger. ' +
        'WRITE TOOL — disabled unless the server has EBOEKHOUDEN_ALLOW_WRITES=true. ' +
        'Dry-run by default: it only creates when `confirm: true` is passed; otherwise it ' +
        'returns the exact body it would send so you can review it first. ' +
        'Required: `code` and `description`. `category` (e.g. "VW" for a profit & loss cost/' +
        'revenue account, "BAL" for balance sheet, "FIN" for a bank/cash account) defaults to ' +
        '"VW" since most ad-hoc accounts are cost accounts. There is no update/delete endpoint ' +
        'for ledgers — correct mistakes in the e-Boekhouden web UI. Returns the created ledger ' +
        '(including its id) so it can be used immediately in `create_purchase_mutation` / ' +
        '`create_money_spent` / `create_sales_invoice` calls.',
      inputSchema: {
        code: z.string().min(1).max(10).describe('Ledger code, e.g. "4560" (max 10 chars).'),
        description: z.string().min(1).max(100).describe('Ledger description, e.g. "Huisvestingskosten".'),
        category: z
          .string()
          .optional()
          .describe('Category: BAL, VW, FIN, DEB, CRED, … Defaults to "VW" (profit & loss).'),
        group: z.string().optional().describe('Ledger group code, if you want to place it in a specific group.'),
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
    async ({ confirm, administration, category, ...fields }) =>
      guard(async () => {
        const body = compact({ category: category ?? 'VW', ...fields });
        return gatedWrite({
          confirm,
          statusKey: 'created',
          plannedKey: 'plannedLedger',
          resultKey: 'ledger',
          body,
          execute: () => client.request({ administration, method: 'POST', path: '/ledger', body }),
        });
      }),
  );
}
