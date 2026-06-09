import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EboekhoudenClient } from '../eboekhouden-client.js';
import { ok, guard } from './result.js';
import { writesEnabled, compact, WRITES_DISABLED_REASON } from './write-helpers.js';

/**
 * Register mutation **write** tools. These are the only tools in this server
 * that mutate data in e-Boekhouden, so they carry two safety layers:
 *
 *   1. Environment gate — writes only run when `EBOEKHOUDEN_ALLOW_WRITES` is
 *      set to a truthy value ("true"/"1"/"yes"). When unset, the tool is still
 *      registered (so agents can discover it) but every call is refused with a
 *      clear message. This keeps the default posture read-only.
 *   2. Dry-run by default — a call only POSTs when `confirm: true` is passed.
 *      Otherwise the tool returns the exact body it *would* have booked, so the
 *      caller (or the user) can review it first.
 *
 * Payment term resolution (when `termOfPayment` is omitted): the tool reads the
 * relation and uses the term configured there; failing that, the caller's
 * `termOfPaymentDefault`; failing that, e-Boekhouden's own default. The chosen
 * source is reported back as `termOfPaymentSource`. Note: the relation read
 * endpoint omits the field entirely when it is empty, so an unset term simply
 * falls through to the next fallback.
 *
 * Endpoint: POST /v1/mutation with `type: 1` (Factuur ontvangen / invoice
 * received) — i.e. a purchase invoice (inkoopfactuur).
 *
 * Body shape mirrors the read shape returned by GET /v1/mutation/{id}:
 *   - top-level `ledgerId` is the creditor counter-account (category CRED),
 *   - each `rows[]` entry is a cost line with a purchase VAT code.
 */

const PURCHASE_MUTATION_TYPE = 1; // Factuur ontvangen / invoice received
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
        'If `termOfPayment` is omitted, it is taken from the relation (falling back to ' +
        '`termOfPaymentDefault`, then e-Boekhouden\'s own default); see `termOfPaymentSource`. ' +
        'The top-level `ledgerId` is the creditor counter-account (category CRED, e.g. ' +
        '"Crediteuren"). Each `rows` entry is a cost line with a purchase VAT code ' +
        '(NL: HOOG_INK_21, LAAG_INK_9, VERL_INK, BU_EU_INK, GEEN, …). ' +
        'Invoice numbers are unique per relation; a duplicate yields API error MUT_019/MUT_020.',
      inputSchema: {
        relationId: z
          .number()
          .int()
          .describe('Numeric id of the supplier relation (use get_relations to look it up).'),
        invoiceNumber: z
          .string()
          .min(1)
          .describe('Supplier invoice number. Unique per relation.'),
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
              vatCode: z
                .string()
                .min(1)
                .describe('Purchase VAT code, e.g. HOOG_INK_21, LAAG_INK_9, VERL_INK, GEEN.'),
              amount: z.number().describe('Line amount, inclusive or exclusive of VAT per `inExVat`.'),
              description: z.string().optional().describe('Optional line description.'),
              vatAmount: z
                .number()
                .optional()
                .describe('Explicit VAT amount; only used with divergent code AFW.'),
              costCenterId: z.number().int().optional().describe('Optional cost center id.'),
            }),
          )
          .min(1)
          .describe('One or more cost lines making up the invoice.'),
        description: z.string().optional().describe('Optional mutation description.'),
        termOfPayment: z.number().int().optional().describe('Payment term in days.'),
        paymentReference: z.string().optional().describe('Optional payment reference (betalingskenmerk).'),
        termOfPaymentDefault: z
          .number()
          .int()
          .optional()
          .describe(
            'Fallback payment term (days) used only when `termOfPayment` is omitted AND the ' +
              'relation has no term set. When this is also omitted, e-Boekhouden applies its own default.',
          ),
        confirm: z
          .boolean()
          .optional()
          .describe('Set true to actually book. When false/omitted, returns a dry-run preview only.'),
        administration: z
          .string()
          .optional()
          .describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
      },
    },
    async ({
      relationId,
      invoiceNumber,
      date,
      ledgerId,
      inExVat,
      rows,
      description,
      termOfPayment,
      paymentReference,
      termOfPaymentDefault,
      confirm,
      administration,
    }) =>
      guard(async () => {
        // Resolve the payment term: an explicit value wins; otherwise fall back
        // to the term configured on the relation, then the caller-supplied
        // default, then e-Boekhouden's own default (by omitting the field).
        let effectiveTerm = termOfPayment;
        let termOfPaymentSource: 'explicit' | 'relation' | 'default' | 'eboekhouden-default' = 'explicit';
        if (effectiveTerm === undefined) {
          const relation = await client.request<{ termOfPayment?: number }>({
            administration,
            path: `/relation/${relationId}`,
          });
          if (typeof relation?.termOfPayment === 'number') {
            effectiveTerm = relation.termOfPayment;
            termOfPaymentSource = 'relation';
          } else if (termOfPaymentDefault !== undefined) {
            effectiveTerm = termOfPaymentDefault;
            termOfPaymentSource = 'default';
          } else {
            termOfPaymentSource = 'eboekhouden-default';
          }
        }

        const body = compact({
          type: PURCHASE_MUTATION_TYPE,
          date,
          ledgerId,
          invoiceNumber,
          description,
          termOfPayment: effectiveTerm,
          inExVat,
          relationId,
          paymentReference,
          rows: rows.map((r) => compact(r)),
        });

        // Safety layer 1: environment gate.
        if (!writesEnabled()) {
          return ok({
            written: false,
            blocked: true,
            reason: WRITES_DISABLED_REASON,
            termOfPaymentSource,
            plannedMutation: body,
          });
        }

        // Safety layer 2: dry-run unless explicitly confirmed.
        if (!confirm) {
          return ok({
            written: false,
            dryRun: true,
            message: 'Dry-run: nothing was booked. Re-run with confirm: true to create this mutation.',
            termOfPaymentSource,
            plannedMutation: body,
          });
        }

        const mutation = await client.request({
          administration,
          method: 'POST',
          path: '/mutation',
          body,
        });
        return ok({ written: true, termOfPaymentSource, mutation });
      }),
  );

  server.registerTool(
    'create_payment',
    {
      description:
        'Register a payment against a purchase invoice (mark it paid) as a type 4 mutation ' +
        '(Factuurbetaling verstuurd) via POST /v1/mutation. WRITE TOOL — disabled unless the ' +
        'server has EBOEKHOUDEN_ALLOW_WRITES=true. Dry-run by default: only books when ' +
        '`confirm: true`. Links to the outstanding invoice by `invoiceNumber` + `relationId`. ' +
        'The payment debits the creditor account and credits the bank account; `amount` is the ' +
        'full paid total (incl. VAT). If `creditorLedgerId` is omitted it is resolved from the ' +
        'single category-CRED ledger; `bankLedgerId` is required (an administration usually has ' +
        'multiple FIN accounts, e.g. Kas + bank).',
      inputSchema: {
        relationId: z.number().int().describe('Supplier relation id (same as on the invoice).'),
        invoiceNumber: z.string().min(1).describe('Invoice number being paid (must match the outstanding invoice).'),
        amount: z.number().describe('Paid amount — full total incl. VAT.'),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be ISO format YYYY-MM-DD.')
          .describe('Payment date (bank transaction date) in ISO format YYYY-MM-DD.'),
        bankLedgerId: z.number().int().describe('Bank ledger id the payment came from (category FIN).'),
        creditorLedgerId: z
          .number()
          .int()
          .optional()
          .describe('Creditor ledger id (category CRED). Auto-resolved when omitted.'),
        description: z.string().optional().describe('Optional description (default "Betaling").'),
        confirm: z
          .boolean()
          .optional()
          .describe('Set true to actually book. When false/omitted, returns a dry-run preview only.'),
        administration: z
          .string()
          .optional()
          .describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
      },
    },
    async ({ relationId, invoiceNumber, amount, date, bankLedgerId, creditorLedgerId, description, confirm, administration }) =>
      guard(async () => {
        // Resolve the creditor account when not supplied (usually a single CRED ledger).
        let creditor = creditorLedgerId;
        if (creditor === undefined) {
          const cred = await client.paginate<{ id: number }>('/ledger', {
            administration,
            query: { category: 'CRED' },
          });
          if (cred.length === 1) {
            creditor = cred[0]!.id;
          } else {
            throw new Error(
              `Could not auto-resolve the creditor ledger (found ${cred.length} CRED ledgers). ` +
                'Pass creditorLedgerId explicitly.',
            );
          }
        }

        const desc = description ?? 'Betaling';
        const body = compact({
          type: PAYMENT_SENT_TYPE,
          date,
          ledgerId: bankLedgerId,
          invoiceNumber,
          description: desc,
          inExVat: 'EX',
          relationId,
          // For a payment (type 4) the linking invoiceNumber AND relationId must be
          // on the row, not only at the mutation level (API errors MUT_120 / MUT_112).
          rows: [compact({ ledgerId: creditor, vatCode: 'GEEN', amount, invoiceNumber, relationId, description: desc })],
        });

        if (!writesEnabled()) {
          return ok({ written: false, blocked: true, reason: WRITES_DISABLED_REASON, plannedPayment: body });
        }
        if (!confirm) {
          return ok({
            written: false,
            dryRun: true,
            message: 'Dry-run: nothing was booked. Re-run with confirm: true to register this payment.',
            plannedPayment: body,
          });
        }

        const mutation = await client.request({ administration, method: 'POST', path: '/mutation', body });
        return ok({ written: true, mutation });
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
        inExVat: z
          .enum(['IN', 'EX'])
          .optional()
          .describe('Whether row amounts include VAT ("IN", default) or exclude it ("EX").'),
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
        confirm: z
          .boolean()
          .optional()
          .describe('Set true to actually book. When false/omitted, returns a dry-run preview only.'),
        administration: z
          .string()
          .optional()
          .describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
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

        if (!writesEnabled()) {
          return ok({ written: false, blocked: true, reason: WRITES_DISABLED_REASON, plannedMutation: body });
        }
        if (!confirm) {
          return ok({
            written: false,
            dryRun: true,
            message: 'Dry-run: nothing was booked. Re-run with confirm: true to book this expense.',
            plannedMutation: body,
          });
        }

        const mutation = await client.request({ administration, method: 'POST', path: '/mutation', body });
        return ok({ written: true, mutation });
      }),
  );
}
