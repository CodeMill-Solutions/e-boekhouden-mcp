import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EboekhoudenClient } from '../eboekhouden-client.js';
import { guard } from './result.js';
import { compact, gatedWrite, resolveTermOfPayment } from './write-helpers.js';

/**
 * Register sales-invoice (verkoopfactuur) write tools.
 *
 * Same guards as the other write tools (env gate + dry-run/confirm) via
 * `gatedWrite`. Endpoint: POST /v1/invoice (the invoicing module).
 *
 * The invoicing module requires a `templateId` (invoice layout) and each line
 * needs a revenue ledger; both are administration-specific. To avoid baking one
 * administration's ids into this package, they may be supplied per call or via
 * environment defaults:
 *   - EBOEKHOUDEN_INVOICE_TEMPLATE_ID  (templateId)
 *   - EBOEKHOUDEN_REVENUE_LEDGER_ID    (item ledgerId)
 *   - EBOEKHOUDEN_DEFAULT_UNIT_ID      (item unitId, optional)
 * A clear error is thrown when a required id is neither passed nor configured.
 */

/** Parse a positive integer from an environment variable, or undefined. */
function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function registerInvoiceWriteTools(server: McpServer, client: EboekhoudenClient): void {
  server.registerTool(
    'create_sales_invoice',
    {
      description:
        'Create a sales invoice (verkoopfactuur) via POST /v1/invoice. ' +
        'WRITE TOOL — disabled unless EBOEKHOUDEN_ALLOW_WRITES=true. Dry-run by default unless ' +
        '`confirm: true`. `invoiceNumber` is optional (e-Boekhouden auto-numbers when omitted). ' +
        'Each item needs a description, pricePerUnit, a sale VAT code (default HOOG_VERK_21) and ' +
        'a revenue ledger. `templateId` and the revenue `ledgerId` are administration-specific: ' +
        'pass them per call or configure EBOEKHOUDEN_INVOICE_TEMPLATE_ID / ' +
        'EBOEKHOUDEN_REVENUE_LEDGER_ID / EBOEKHOUDEN_DEFAULT_UNIT_ID. ' +
        'If `termOfPayment` is omitted it is taken from the relation (then 14 days); see ' +
        '`termOfPaymentSource`.',
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
              ledgerId: z.number().int().optional().describe('Revenue ledger id (or EBOEKHOUDEN_REVENUE_LEDGER_ID).'),
              unitId: z.number().int().optional().describe('Unit id (or EBOEKHOUDEN_DEFAULT_UNIT_ID).'),
              code: z.string().optional().describe('Optional item code.'),
            }),
          )
          .min(1)
          .describe('One or more invoice lines.'),
        invoiceNumber: z.string().optional().describe('Optional; e-Boekhouden auto-numbers when omitted.'),
        templateId: z.number().int().optional().describe('Invoice layout template id (or EBOEKHOUDEN_INVOICE_TEMPLATE_ID).'),
        termOfPayment: z.number().int().optional().describe('Payment term in days. Omit to take it from the relation.'),
        inExVat: z.enum(['IN', 'EX']).optional().describe('Item prices incl ("IN") or excl ("EX", default) VAT.'),
        reference: z.string().optional().describe('Optional reference.'),
        text: z.string().optional().describe('Optional invoice text.'),
        confirm: z.boolean().optional().describe('Set true to actually create. When false/omitted, returns a dry-run preview only.'),
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
      },
    },
    async ({ relationId, date, items, invoiceNumber, templateId, termOfPayment, inExVat, reference, text, confirm, administration }) =>
      guard(async () => {
        const tpl = templateId ?? envInt('EBOEKHOUDEN_INVOICE_TEMPLATE_ID');
        if (tpl === undefined) {
          throw new Error(
            'templateId is required: pass it or set EBOEKHOUDEN_INVOICE_TEMPLATE_ID. ' +
              'Invoice templates are administration-specific (see existing invoices for the id).',
          );
        }
        const defRevenue = envInt('EBOEKHOUDEN_REVENUE_LEDGER_ID');
        const defUnit = envInt('EBOEKHOUDEN_DEFAULT_UNIT_ID');

        const mappedItems = items.map((it) => {
          const ledgerId = it.ledgerId ?? defRevenue;
          if (ledgerId === undefined) {
            throw new Error(
              'Each item needs a revenue ledgerId: pass item.ledgerId or set EBOEKHOUDEN_REVENUE_LEDGER_ID.',
            );
          }
          return compact({
            quantity: it.quantity ?? 1,
            unitId: it.unitId ?? defUnit,
            code: it.code,
            description: it.description,
            pricePerUnit: it.pricePerUnit,
            vatCode: it.vatCode ?? 'HOOG_VERK_21',
            ledgerId,
          });
        });

        const { term, source } = await resolveTermOfPayment(client, administration, relationId, termOfPayment, 14);
        const body = compact({
          invoiceNumber,
          relationId,
          date,
          termOfPayment: term,
          inExVat: inExVat ?? 'EX',
          templateId: tpl,
          reference,
          text,
          items: mappedItems,
        });

        return gatedWrite({
          confirm,
          statusKey: 'created',
          plannedKey: 'plannedInvoice',
          resultKey: 'invoice',
          body,
          extra: { termOfPaymentSource: source },
          execute: () => client.request({ administration, method: 'POST', path: '/invoice', body }),
        });
      }),
  );
}
