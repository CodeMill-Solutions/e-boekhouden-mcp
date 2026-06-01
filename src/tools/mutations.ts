import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EboekhoudenClient } from '../eboekhouden-client.js';
import { ok, guard } from './result.js';

/**
 * Register mutation (mutaties / boekingen) read tools — the core ledger
 * entries.
 *
 * Mutation `type` values (per the API's MutationType enum):
 *   1 Invoice received        5 Money received
 *   2 Invoice sent            6 Money sent
 *   3 Invoice payment received 7 General journal entry
 *   4 Invoice payment sent
 *
 * Endpoints:
 *   - GET /v1/mutation                    → list, with filters
 *   - GET /v1/mutation/{id}               → single mutation (full detail)
 *   - GET /v1/mutation/invoice/outstanding → outstanding invoices (open posten)
 */
export const MUTATION_TYPE_LABELS: Record<number, string> = {
  1: 'Invoice received',
  2: 'Invoice sent',
  3: 'Invoice payment received',
  4: 'Invoice payment sent',
  5: 'Money received',
  6: 'Money sent',
  7: 'General journal entry',
};

export function registerMutationTools(server: McpServer, client: EboekhoudenClient): void {
  server.registerTool(
    'get_mutations',
    {
      description:
        'List mutations (mutaties / bookkeeping entries). Each item has id, type, date, ' +
        'invoiceNumber, ledgerId, amount and entryNumber. Filter by type (1=invoice received, ' +
        '2=invoice sent, 3=payment received, 4=payment sent, 5=money received, 6=money sent, ' +
        '7=general journal), invoiceNumber or description. Auto-paginated. Calls GET /v1/mutation.',
      inputSchema: {
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
        type: z
          .number()
          .int()
          .min(1)
          .max(7)
          .optional()
          .describe('Filter by mutation type (1–7). See the tool description for the mapping.'),
        invoiceNumber: z.string().optional().describe('Filter by invoice number.'),
        description: z.string().optional().describe('Filter by (partial) description.'),
        maxItems: z.number().int().positive().optional().describe('Cap on total items returned (default 1000).'),
      },
    },
    async ({ administration, type, invoiceNumber, description, maxItems }) =>
      guard(async () => {
        const items = await client.paginate<Record<string, unknown>>('/mutation', {
          administration,
          query: { type, invoiceNumber, description },
          maxItems,
        });
        // Annotate each row with a human-readable type label.
        const mutations = items.map((m) => {
          const t = typeof m['type'] === 'number' ? (m['type'] as number) : undefined;
          return t && MUTATION_TYPE_LABELS[t] ? { ...m, typeLabel: MUTATION_TYPE_LABELS[t] } : m;
        });
        return ok({ count: mutations.length, mutations });
      }),
  );

  server.registerTool(
    'get_mutation',
    {
      description:
        'Read a single mutation by its numeric id, including all booking lines. ' +
        'Calls GET /v1/mutation/{id}.',
      inputSchema: {
        id: z.number().int().describe('Numeric mutation id.'),
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
      },
    },
    async ({ id, administration }) =>
      guard(async () => {
        const mutation = await client.request({ administration, path: `/mutation/${id}` });
        return ok({ mutation });
      }),
  );

  server.registerTool(
    'get_outstanding_invoices',
    {
      description:
        'List outstanding invoices (openstaande posten). `credDeb` is REQUIRED by the API and ' +
        'must be "D" (debit — outstanding sales invoices / receivables) or "C" (credit — ' +
        'outstanding purchase invoices / payables). Optionally filter by invoiceNumber. ' +
        'Auto-paginated. Calls GET /v1/mutation/invoice/outstanding.',
      inputSchema: {
        credDeb: z
          .enum(['D', 'C'])
          .describe('Required: "D" (debit / receivables / sales) or "C" (credit / payables / purchases).'),
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
        invoiceNumber: z.string().optional().describe('Filter by invoice number.'),
        maxItems: z.number().int().positive().optional().describe('Cap on total items returned (default 1000).'),
      },
    },
    async ({ administration, credDeb, invoiceNumber, maxItems }) =>
      guard(async () => {
        const items = await client.paginate('/mutation/invoice/outstanding', {
          administration,
          query: { credDeb, invoiceNumber },
          maxItems,
        });
        return ok({ count: items.length, outstanding: items });
      }),
  );
}
