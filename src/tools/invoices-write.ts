import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EboekhoudenClient } from '../eboekhouden-client.js';
import { ok, guard } from './result.js';
import { writesEnabled, compact, WRITES_DISABLED_REASON } from './write-helpers.js';

/**
 * Register sales-invoice (verkoopfactuur) write tools.
 *
 * Same two guards as the other write tools: env gate + dry-run/confirm.
 *
 * Endpoint: POST /v1/invoice (the invoicing module). Field/item names mirror the
 * read shape of GET /v1/invoice/{id}. `invoiceNumber` is optional — when omitted
 * e-Boekhouden assigns the next number automatically. A `templateId` (invoice
 * layout) is required by the module; default to the administration's template.
 */
export function registerInvoiceWriteTools(server: McpServer, client: EboekhoudenClient): void {
  server.registerTool(
    'create_sales_invoice',
    {
      description:
        'Create a sales invoice (verkoopfactuur) via POST /v1/invoice. ' +
        'WRITE TOOL — disabled unless EBOEKHOUDEN_ALLOW_WRITES=true. Dry-run by default unless ' +
        '`confirm: true`. `invoiceNumber` is optional (e-Boekhouden auto-numbers when omitted). ' +
        'Each item needs a description, pricePerUnit, sale VAT code (e.g. HOOG_VERK_21) and a ' +
        'revenue ledger (e.g. 8000 Omzet 21%). Defaults target this administration: templateId ' +
        '752296, revenue ledger 22206462 (8000), VAT HOOG_VERK_21, unit "stuk" (3214082).',
      inputSchema: {
        relationId: z.number().int().describe('Customer relation id.'),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be ISO format YYYY-MM-DD.')
          .describe('Invoice date in ISO format YYYY-MM-DD.'),
        items: z
          .array(
            z.object({
              description: z.string().min(1).describe('Line description.'),
              pricePerUnit: z.number().describe('Price per unit (excl/incl per inExVat).'),
              quantity: z.number().optional().describe('Quantity (default 1).'),
              vatCode: z.string().optional().describe('Sale VAT code (default HOOG_VERK_21).'),
              ledgerId: z.number().int().optional().describe('Revenue ledger id (default 22206462 = 8000).'),
              unitId: z.number().int().optional().describe('Unit id (default 3214082 = stuk).'),
              code: z.string().optional().describe('Optional item code.'),
            }),
          )
          .min(1)
          .describe('One or more invoice lines.'),
        invoiceNumber: z.string().optional().describe('Optional; e-Boekhouden auto-numbers when omitted.'),
        templateId: z.number().int().optional().describe('Invoice layout template id (default 752296).'),
        termOfPayment: z.number().int().optional().describe('Payment term in days (default 14).'),
        inExVat: z.enum(['IN', 'EX']).optional().describe('Item prices incl ("IN") or excl ("EX", default) VAT.'),
        reference: z.string().optional().describe('Optional reference.'),
        text: z.string().optional().describe('Optional invoice text.'),
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
    async ({ relationId, date, items, invoiceNumber, templateId, termOfPayment, inExVat, reference, text, confirm, administration }) =>
      guard(async () => {
        const body = compact({
          invoiceNumber,
          relationId,
          date,
          termOfPayment: termOfPayment ?? 14,
          inExVat: inExVat ?? 'EX',
          templateId: templateId ?? 752296,
          reference,
          text,
          items: items.map((it) => {
            const quantity = it.quantity ?? 1;
            return compact({
              quantity,
              amount: quantity,
              unitId: it.unitId ?? 3214082,
              code: it.code,
              description: it.description,
              pricePerUnit: it.pricePerUnit,
              vatCode: it.vatCode ?? 'HOOG_VERK_21',
              ledgerId: it.ledgerId ?? 22206462,
            });
          }),
        });

        if (!writesEnabled()) {
          return ok({ created: false, blocked: true, reason: WRITES_DISABLED_REASON, plannedInvoice: body });
        }
        if (!confirm) {
          return ok({
            created: false,
            dryRun: true,
            message: 'Dry-run: nothing was created. Re-run with confirm: true to create this invoice.',
            plannedInvoice: body,
          });
        }

        const invoice = await client.request({ administration, method: 'POST', path: '/invoice', body });
        return ok({ created: true, invoice });
      }),
  );
}
