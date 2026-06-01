import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EboekhoudenClient } from '../eboekhouden-client.js';
import { ok, guard } from './result.js';

/**
 * Register ledger (grootboekrekening) read tools.
 *
 * Ledgers are the chart of accounts. e-Boekhouden classifies each into a
 * `category` (BAL = balance, VW = profit & loss, FIN = financial, DEB/CRED =
 * receivables/payables, plus several VAT categories).
 *
 * Endpoints:
 *   - GET /v1/ledger              → list, filter by code/category
 *   - GET /v1/ledger/{id}         → single ledger
 *   - GET /v1/ledger/balances     → balances across ledgers for a period
 *   - GET /v1/ledger/{id}/balance → balance of a single ledger
 */
export function registerLedgerTools(server: McpServer, client: EboekhoudenClient): void {
  server.registerTool(
    'get_ledgers',
    {
      description:
        'List general-ledger accounts (grootboekrekeningen). Each item has id, code, ' +
        'description, category (BAL/VW/FIN/DEB/CRED/…) and group. Supports filtering by code ' +
        'or category and is auto-paginated. Calls GET /v1/ledger.',
      inputSchema: {
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
        code: z.string().optional().describe('Filter by exact ledger code.'),
        category: z
          .string()
          .optional()
          .describe('Filter by category, e.g. BAL (balance), VW (P&L), FIN, DEB, CRED.'),
        maxItems: z.number().int().positive().optional().describe('Cap on total items returned (default 1000).'),
      },
    },
    async ({ administration, code, category, maxItems }) =>
      guard(async () => {
        const items = await client.paginate('/ledger', {
          administration,
          query: { code, category },
          maxItems,
        });
        return ok({ count: items.length, ledgers: items });
      }),
  );

  server.registerTool(
    'get_ledger',
    {
      description: 'Read a single general-ledger account by its numeric id. Calls GET /v1/ledger/{id}.',
      inputSchema: {
        id: z.number().int().describe('Numeric ledger id.'),
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
      },
    },
    async ({ id, administration }) =>
      guard(async () => {
        const ledger = await client.request({ administration, path: `/ledger/${id}` });
        return ok({ ledger });
      }),
  );

  server.registerTool(
    'get_ledger_balances',
    {
      description:
        'Get balances across general-ledger accounts for an optional period and cost center. ' +
        'Calls GET /v1/ledger/balances.',
      inputSchema: {
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
        from: z.string().optional().describe('Start date (YYYY-MM-DD).'),
        to: z.string().optional().describe('End date (YYYY-MM-DD).'),
        costCenterId: z.number().int().optional().describe('Limit to a single cost center id.'),
      },
    },
    async ({ administration, from, to, costCenterId }) =>
      guard(async () => {
        const balances = await client.request({
          administration,
          path: '/ledger/balances',
          query: { from, to, costCenterId },
        });
        return ok({ balances });
      }),
  );

  server.registerTool(
    'get_ledger_balance',
    {
      description: 'Get the balance of a single general-ledger account. Calls GET /v1/ledger/{id}/balance.',
      inputSchema: {
        id: z.number().int().describe('Numeric ledger id.'),
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
        from: z.string().optional().describe('Start date (YYYY-MM-DD).'),
        to: z.string().optional().describe('End date (YYYY-MM-DD).'),
      },
    },
    async ({ id, administration, from, to }) =>
      guard(async () => {
        const balance = await client.request({
          administration,
          path: `/ledger/${id}/balance`,
          query: { from, to },
        });
        return ok({ balance });
      }),
  );
}
