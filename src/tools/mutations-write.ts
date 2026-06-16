import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EboekhoudenClient } from '../eboekhouden-client.js';
import { guard } from './result.js';
import { writesEnabled, compact, gatedWrite, resolveTermOfPayment, resolveSingleLedger } from './write-helpers.js';

/**
 * Register mutation **write** tools. These mutate data in e-Boekhouden, so they
 * all go through `gatedWrite` (write-helpers.ts), which enforces two guards:
 *   1. env gate — refused unless EBOEKHOUDEN_ALLOW_WRITES is truthy;
 *   2. dry-run — only writes when `confirm: true`, otherwise echoes the body.
 *
 * Body shapes mirror the read shape of GET /v1/mutation/{id}.
 */

const PURCHASE_MUTATION_TYPE = 1; // Factuur ontvangen / invoice received
const PAYMENT_RECEIVED_TYPE = 3; // Factuurbetaling ontvangen / invoice payment received
const PAYMENT_SENT_TYPE = 4; // Factuurbetaling verstuurd / invoice payment sent
const MONEY_SENT_TYPE = 6; // Geld uitgegeven / money spent

export function registerMutationWriteTools(server: McpServer, client: EboekhoudenClient): void {
  server.registerTool(
    'create_purchase_mutation',
    {
      description:
        'Create a purchase invoice (inkoopfactuur) as a bookkeeping mutation of type 1 ' +
        '(Factuur ontvangen) via POST /v1/mutation. ' +
        'WRITE TOOL — disabled unless the server has EBOEKHOUDEN_ALLOW_WRITES=true. ' +
        'Dry-run by default: it only books when `confirm: true` is passed; otherwise it ' +
        'returns the exact mutation body it would send so you can review it first. ' +
        "If `termOfPayment` is omitted, it is taken from the relation (falling back to " +
        "`termOfPaymentDefault`, then e-Boekhouden's own default); see `termOfPaymentSource`. " +
        'The top-level `ledgerId` is the creditor counter-account (category CRED, e.g. ' +
        '"Crediteuren"). Each `rows` entry is a cost line with a purchase VAT code ' +
        '(NL: HOOG_INK_21, LAAG_INK_9, VERL_INK, BU_EU_INK, GEEN, …). ' +
        'Invoice numbers are unique per relation; a duplicate yields API error MUT_019/MUT_020.',
      inputSchema: {
        relationId: z.number().int().describe('Numeric id of the supplier relation (use get_relations to look it up).'),
        invoiceNumber: z.string().min(1).describe('Supplier invoice number. Unique per relation.'),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be ISO format YYYY-MM-DD.')
          .describe('Invoice date in ISO format YYYY-MM-DD.'),
        ledgerId: z
          .number()
          .int()
          .describe('Creditor counter-account ledger id (category CRED, e.g. Crediteuren).'),
        inExVat: z
          .enum(['IN', 'EX'])
          .describe('Whether row `amount` values are inclusive ("IN") or exclusive ("EX") of VAT.'),
        rows: z
          .array(
            z.object({
              ledgerId: z.number().int().describe('Cost/expense ledger id for this line (category VW).'),
              vatCode: z.string().min(1).describe('Purchase VAT code, e.g. HOOG_INK_21, LAAG_INK_9, VERL_INK, GEEN.'),
              amount: z.number().describe('Line amount, inclusive or exclusive of VAT per `inExVat`.'),
              description: z.string().optional().describe('Optional line description.'),
              vatAmount: z.number().optional().describe('Explicit VAT amount; only used with divergent code AFW.'),
              costCenterId: z.number().int().optional().describe('Optional cost center id.'),
            }),
          )
          .min(1)
          .describe('One or more cost lines making up the invoice.'),
        description: z.string().optional().describe('Optional mutation description.'),
        termOfPayment: z.number().int().optional().describe('Payment term in days. Omit to take it from the relation.'),
        termOfPaymentDefault: z
          .number()
          .int()
          .optional()
          .describe('Fallback term (days) when `termOfPayment` is omitted AND the relation has none set.'),
        paymentReference: z.string().optional().describe('Optional payment reference (betalingskenmerk).'),
        confirm: z.boolean().optional().describe('Set true to actually book. When false/omitted, returns a dry-run preview only.'),
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
      },
    },
    async ({ relationId, invoiceNumber, date, ledgerId, inExVat, rows, description, termOfPayment, termOfPaymentDefault, paymentReference, confirm, administration }) =>
      guard(async () => {
        const { term, source } = await resolveTermOfPayment(client, administration, relationId, termOfPayment, termOfPaymentDefault);
        const body = compact({
          type: PURCHASE_MUTATION_TYPE,
          date,
          ledgerId,
          invoiceNumber,
          description,
          termOfPayment: term,
          inExVat,
          relationId,
          paymentReference,
          rows: rows.map((r) => compact(r)),
        });
        return gatedWrite({
          confirm,
          plannedKey: 'plannedMutation',
          resultKey: 'mutation',
          body,
          extra: { termOfPaymentSource: source },
          execute: () => client.request({ administration, method: 'POST', path: '/mutation', body }),
        });
      }),
  );

  server.registerTool(
    'create_payment',
    {
      description:
        'Register a payment against an invoice via POST /v1/mutation. ' +
        '`direction: "sent"` (default) marks a PURCHASE invoice paid (type 4, Factuurbetaling ' +
        'verstuurd, books against the creditor account); `direction: "received"` marks a SALES ' +
        'invoice paid (type 3, Factuurbetaling ontvangen, books against the debtor account). ' +
        'WRITE TOOL — disabled unless EBOEKHOUDEN_ALLOW_WRITES=true. Dry-run by default: only ' +
        'books when `confirm: true`. Links to the outstanding invoice by `invoiceNumber` + ' +
        '`relationId` (both required on the row, else MUT_120 / MUT_112). `amount` is the full ' +
        'paid total (incl. VAT). `contraLedgerId` (creditor for sent, debtor for received) is ' +
        'auto-resolved from the single CRED/DEB ledger when omitted; `bankLedgerId` is required.',
      inputSchema: {
        relationId: z.number().int().describe('Relation id (same as on the invoice).'),
        invoiceNumber: z.string().min(1).describe('Invoice number being paid (must match the outstanding invoice).'),
        amount: z.number().describe('Paid amount — full total incl. VAT.'),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be ISO format YYYY-MM-DD.')
          .describe('Payment date (bank transaction date) in ISO format YYYY-MM-DD.'),
        bankLedgerId: z.number().int().describe('Bank ledger id (category FIN).'),
        direction: z
          .enum(['sent', 'received'])
          .optional()
          .describe('"sent" = pay a purchase invoice (type 4, default); "received" = received payment on a sales invoice (type 3).'),
        contraLedgerId: z
          .number()
          .int()
          .optional()
          .describe('Counter account: creditor (sent) or debtor (received). Auto-resolved when omitted.'),
        description: z.string().optional().describe('Optional description (default "Betaling").'),
        confirm: z.boolean().optional().describe('Set true to actually book. When false/omitted, returns a dry-run preview only.'),
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
      },
    },
    async ({ relationId, invoiceNumber, amount, date, bankLedgerId, direction, contraLedgerId, description, confirm, administration }) =>
      guard(async () => {
        const received = direction === 'received';
        const type = received ? PAYMENT_RECEIVED_TYPE : PAYMENT_SENT_TYPE;
        // Resolve the counter account only when we'll actually write — keeps a
        // blocked (writes-disabled) call from doing a needless ledger lookup.
        let contra = contraLedgerId;
        if (contra === undefined && writesEnabled()) {
          contra = received
            ? await resolveSingleLedger(client, administration, 'DEB', 'debtor')
            : await resolveSingleLedger(client, administration, 'CRED', 'creditor');
        }
        const desc = description ?? 'Betaling';
        const body = compact({
          type,
          date,
          ledgerId: bankLedgerId,
          invoiceNumber,
          description: desc,
          inExVat: 'EX',
          relationId,
          // payments need invoiceNumber AND relationId on the row (MUT_120 / MUT_112).
          rows: [compact({ ledgerId: contra, vatCode: 'GEEN', amount, invoiceNumber, relationId, description: desc })],
        });
        return gatedWrite({
          confirm,
          plannedKey: received ? 'plannedReceipt' : 'plannedPayment',
          resultKey: 'mutation',
          body,
          execute: () => client.request({ administration, method: 'POST', path: '/mutation', body }),
        });
      }),
  );

  server.registerTool(
    'create_money_spent',
    {
      description:
        'Book money spent directly from a bank/cash account (Geld uitgegeven, type 6) via ' +
        'POST /v1/mutation. For expenses paid directly, without a separate purchase invoice — ' +
        'e.g. bank charges, insurance premiums collected by direct debit, or receipts. ' +
        'WRITE TOOL — disabled unless EBOEKHOUDEN_ALLOW_WRITES=true. Dry-run by default unless ' +
        '`confirm: true`. Top-level `ledgerId` (here `bankLedgerId`) is the bank/cash account the ' +
        'money left from (category FIN); each row is an expense line with its ledger + VAT code. ' +
        'No invoice number or relation is required.',
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be ISO format YYYY-MM-DD.')
          .describe('Transaction date (bank date) in ISO format YYYY-MM-DD.'),
        bankLedgerId: z.number().int().describe('Bank/cash ledger id the money left from (category FIN).'),
        inExVat: z.enum(['IN', 'EX']).optional().describe('Whether row amounts include VAT ("IN", default) or exclude it ("EX").'),
        rows: z
          .array(
            z.object({
              ledgerId: z.number().int().describe('Expense ledger id for this line (category VW).'),
              vatCode: z.string().min(1).describe('VAT code, e.g. HOOG_INK_21, LAAG_INK_9, GEEN.'),
              amount: z.number().describe('Line amount, incl/excl VAT per `inExVat`.'),
              description: z.string().optional().describe('Optional line description.'),
              vatAmount: z.number().optional().describe('Explicit VAT amount; only with divergent code AFW.'),
              costCenterId: z.number().int().optional().describe('Optional cost center id.'),
            }),
          )
          .min(1)
          .describe('One or more expense lines.'),
        description: z.string().optional().describe('Optional mutation description.'),
        relationId: z.number().int().optional().describe('Optional relation id (usually omitted).'),
        confirm: z.boolean().optional().describe('Set true to actually book. When false/omitted, returns a dry-run preview only.'),
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
      },
    },
    async ({ date, bankLedgerId, inExVat, rows, description, relationId, confirm, administration }) =>
      guard(async () => {
        const body = compact({
          type: MONEY_SENT_TYPE,
          date,
          ledgerId: bankLedgerId,
          description,
          inExVat: inExVat ?? 'IN',
          relationId,
          rows: rows.map((r) => compact(r)),
        });
        return gatedWrite({
          confirm,
          plannedKey: 'plannedMutation',
          resultKey: 'mutation',
          body,
          execute: () => client.request({ administration, method: 'POST', path: '/mutation', body }),
        });
      }),
  );
}
