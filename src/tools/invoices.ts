import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EboekhoudenClient } from '../eboekhouden-client.js';
import { ok, guard } from './result.js';

/**
 * Register invoice (verkoopfacturen) read tools — the invoicing module, as
 * opposed to the raw bookkeeping mutations.
 *
 * Endpoints:
 *   - GET /v1/invoice       → list, filter by invoiceNumber/relationId/date
 *   - GET /v1/invoice/{id}  → single invoice with lines
 */
export function registerInvoiceTools(server: McpServer, client: EboekhoudenClient): void {
  server.registerTool(
    'get_invoices',
    {
      description:
        'List sales invoices from the invoicing module. Filter by invoiceNumber, relationId or ' +
        'date. Auto-paginated. Calls GET /v1/invoice.',
      inputSchema: {
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
        invoiceNumber: z.string().optional().describe('Filter by invoice number.'),
        relationId: z.number().int().optional().describe('Filter by relation id.'),
        date: z.string().optional().describe('Filter by invoice date (YYYY-MM-DD).'),
        maxItems: z.number().int().positive().optional().describe('Cap on total items returned (default 1000).'),
      },
    },
    async ({ administration, invoiceNumber, relationId, date, maxItems }) =>
      guard(async () => {
        const items = await client.paginate('/invoice', {
          administration,
          query: { invoiceNumber, relationId, date },
          maxItems,
        });
        return ok({ count: items.length, invoices: items });
      }),
  );

  server.registerTool(
    'get_invoice',
    {
      description: 'Read a single sales invoice by its numeric id, including line items. Calls GET /v1/invoice/{id}.',
      inputSchema: {
        id: z.number().int().describe('Numeric invoice id.'),
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
      },
    },
    async ({ id, administration }) =>
      guard(async () => {
        const invoice = await client.request({ administration, path: `/invoice/${id}` });
        return ok({ invoice });
      }),
  );
}
