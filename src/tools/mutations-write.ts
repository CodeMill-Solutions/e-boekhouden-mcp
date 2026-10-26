import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EboekhoudenClient } from '../eboekhouden-client.js';
import { guard } from './result.js';
import {
  writesEnabled,
  compact,
  gatedWrite,
  resolveTermOfPayment,
  resolveSingleLedger,
  targetAdministration,
} from './write-helpers.js';

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
const MONEY_RECEIVED_TYPE = 5; // Geld ontvangen / money received
const MONEY_SENT_TYPE = 6; // Geld uitgegeven / money spent

/**
 * Every VAT code POST /v1/mutation accepts (the `rows[].vatCode` enum in the
 * spec).
 *
 * VERIFIED against the spec's error table: MUT_110 is "VAT code must be of type
 * purchase" and MUT_111 is "VAT code must be of type sale", and the NL VAT-code
 * table labels every code as Type = Purchase or Sale (GEEN has no type).
 *
 * NOT VERIFIED: which mutation type demands which family. The spec never ties
 * MUT_110/MUT_111 to a type, and we have not round-tripped a rejection against
 * the live API. The convention below is inferred from the error wording and from
 * observed practice (in a live administration all 82 type-5 mutations use a sale
 * code or GEEN, none a purchase code): purchase codes (*_INK) on types 1/6,
 * sale codes (*_VERK) on types 2/5. Treat it as a strong default, not as
 * documented API behaviour — if a call fails on MUT_110/MUT_111, the error text
 * itself names the family the API wants.
 */
const VAT_CODES = [
  'HOOG_VERK_21',
  'LAAG_VERK_9',
  'VERL_VERK',
  'VERL_VERK_L9',
  'AFW',
  'BU_EU_VERK',
  'BI_EU_VERK',
  'BI_EU_VERK_D',
  'AFST_VERK',
  'LAAG_INK_9',
  'HOOG_INK_21',
  'VERL_INK',
  'AFW_VERK',
  'BU_EU_INK',
  'BI_EU_INK',
  'GEEN',
] as const;

/**
 * Row shape shared by every mutation body (mirrors `rows[]` in the spec). Only
 * the two hints differ per tool: what the row ledger represents and which VAT
 * codes fit the mutation type.
 */
function mutationRowSchema(ledgerHint: string, vatHint: string) {
  return z.object({
    ledgerId: z.number().int().describe(ledgerHint),
    vatCode: z.enum(VAT_CODES).describe(vatHint),
    amount: z.number().describe('Line amount, inclusive or exclusive of VAT per `inExVat`.'),
    description: z.string().optional().describe('Optional line description.'),
    vatAmount: z.number().optional().describe('Explicit VAT amount; only used with divergent code AFW / AFW_VERK.'),
    costCenterId: z.number().int().optional().describe('Optional cost center id.'),
  });
}

/** The API rejects these row-ledger categories on types 1, 2, 5 and 6 (MUT_106). */
const ROW_LEDGER_RESTRICTION = 'Must NOT be a FIN, CRED or DEB ledger (API error MUT_106).';

interface MoneyMutationSpec {
  name: 'create_money_spent' | 'create_money_received';
  type: typeof MONEY_SENT_TYPE | typeof MONEY_RECEIVED_TYPE;
  description: string;
  /** Hint for `bankLedgerId`. */
  bankHint: string;
  /** Hint for each row's ledger. */
  ledgerHint: string;
  /** Hint for each row's VAT code. */
  vatHint: string;
  /** Hint for the `rows` array. */
  rowsHint: string;
}

/**
 * Money spent (type 6) and money received (type 5) are the same booking with the
 * bank account on the other side: top-level `ledgerId` is the FIN account, rows
 * are the counter-account lines. One registration keeps the two in lock-step.
 */
function registerMoneyMutationTool(server: McpServer, client: EboekhoudenClient, spec: MoneyMutationSpec): void {
  server.registerTool(
    spec.name,
    {
      description: spec.description,
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be ISO format YYYY-MM-DD.')
          .describe('Transaction date (bank date) in ISO format YYYY-MM-DD.'),
        bankLedgerId: z.number().int().describe(spec.bankHint),
        inExVat: z
          .enum(['IN', 'EX'])
          .optional()
          .describe('Whether row amounts include VAT ("IN", default) or exclude it ("EX").'),
        rows: z.array(mutationRowSchema(spec.ledgerHint, spec.vatHint)).min(1).describe(spec.rowsHint),
        description: z.string().optional().describe('Optional mutation description.'),
        relationId: z.number().int().optional().describe('Optional relation id (usually omitted).'),
        confirm: z
          .boolean()
          .optional()
          .describe('Set true to actually book. When false/omitted, returns a dry-run preview only.'),
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
      },
    },
    async ({ date, bankLedgerId, inExVat, rows, description, relationId, confirm, administration }) =>
      guard(async () => {
        const body = compact({
          type: spec.type,
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
          administration: targetAdministration(client, administration),
          body,
          execute: () => client.request({ administration, method: 'POST', path: '/mutation', body }),
        });
      }),
  );
}

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
        ledgerId: z.number().int().describe('Creditor counter-account ledger id (category CRED, e.g. Crediteuren).'),
        inExVat: z
          .enum(['IN', 'EX'])
          .describe('Whether row `amount` values are inclusive ("IN") or exclusive ("EX") of VAT.'),
        rows: z
          .array(
            mutationRowSchema(
              `Cost/expense ledger id for this line (category VW). ${ROW_LEDGER_RESTRICTION}`,
              'Purchase VAT code (HOOG_INK_21, LAAG_INK_9, VERL_INK, BU_EU_INK, BI_EU_INK, GEEN, …); a sale code yields MUT_110.',
            ),
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
        confirm: z
          .boolean()
          .optional()
          .describe('Set true to actually book. When false/omitted, returns a dry-run preview only.'),
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
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
      termOfPaymentDefault,
      paymentReference,
      confirm,
      administration,
    }) =>
      guard(async () => {
        const { term, source } = await resolveTermOfPayment(
          client,
          administration,
          relationId,
          termOfPayment,
          termOfPaymentDefault,
        );
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
          administration: targetAdministration(client, administration),
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
          .describe(
            '"sent" = pay a purchase invoice (type 4, default); "received" = received payment on a sales invoice (type 3).',
          ),
        contraLedgerId: z
          .number()
          .int()
          .optional()
          .describe('Counter account: creditor (sent) or debtor (received). Auto-resolved when omitted.'),
        description: z.string().optional().describe('Optional description (default "Betaling").'),
        confirm: z
          .boolean()
          .optional()
          .describe('Set true to actually book. When false/omitted, returns a dry-run preview only.'),
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
      },
    },
    async ({
      relationId,
      invoiceNumber,
      amount,
      date,
      bankLedgerId,
      direction,
      contraLedgerId,
      description,
      confirm,
      administration,
    }) =>
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
          administration: targetAdministration(client, administration),
          body,
          execute: () => client.request({ administration, method: 'POST', path: '/mutation', body }),
        });
      }),
  );

  registerMoneyMutationTool(server, client, {
    name: 'create_money_spent',
    type: MONEY_SENT_TYPE,
    description:
      'Book money spent directly from a bank/cash account (Geld uitgegeven, type 6) via ' +
      'POST /v1/mutation. For expenses paid directly, without a separate purchase invoice — ' +
      'e.g. bank charges, insurance premiums collected by direct debit, or receipts. ' +
      'WRITE TOOL — disabled unless EBOEKHOUDEN_ALLOW_WRITES=true. Dry-run by default unless ' +
      '`confirm: true`. Top-level `ledgerId` (here `bankLedgerId`) is the bank/cash account the ' +
      'money left from (category FIN); each row is an expense line with its ledger + purchase VAT ' +
      'code. Row ledgers may not be FIN/CRED/DEB (MUT_106) — for a transfer between your own ' +
      'accounts book the sending leg here against a suspense account (kruisposten) with vatCode ' +
      '"GEEN", see `create_money_received`. No invoice number or relation is required.',
    bankHint: 'Bank/cash ledger id the money left from (category FIN).',
    ledgerHint: `Expense ledger id for this line (category VW, or a BAL suspense account). ${ROW_LEDGER_RESTRICTION}`,
    vatHint:
      'Purchase VAT code (HOOG_INK_21, LAAG_INK_9, VERL_INK, GEEN, …). A sale code is expected to ' +
      'fail with MUT_110 ("VAT code must be of type purchase") — inferred from the error wording, ' +
      'not documented per mutation type.',
    rowsHint: 'One or more expense lines.',
  });

  registerMoneyMutationTool(server, client, {
    name: 'create_money_received',
    type: MONEY_RECEIVED_TYPE,
    description:
      'Book money received directly into a bank/cash account (Geld ontvangen, type 5) via ' +
      'POST /v1/mutation. The mirror of `create_money_spent`: for money coming in without a ' +
      'sales invoice — e.g. interest received, a refund, or the receiving leg of an internal ' +
      'transfer between your own accounts. ' +
      'WRITE TOOL — disabled unless EBOEKHOUDEN_ALLOW_WRITES=true. Dry-run by default unless ' +
      '`confirm: true`. Top-level `ledgerId` (here `bankLedgerId`) is the bank/cash account the ' +
      'money arrived in (category FIN); each row is a counter-account line with its ledger + sale ' +
      'VAT code (HOOG_VERK_21, …, or GEEN — a purchase code yields MUT_111). Row ledgers may not ' +
      'be FIN/CRED/DEB (MUT_106): the other bank account is NOT a valid counter-account. ' +
      'No invoice number or relation is required. ' +
      'NOTE for internal transfers between your own accounts: book BOTH legs over a suspense ' +
      'account (kruisposten, category BAL) so it nets to zero — `create_money_spent` from the ' +
      'source account with a row on kruisposten, plus `create_money_received` into the destination ' +
      'account with a row on that same kruisposten ledger. Both rows use vatCode "GEEN": a ' +
      'transfer carries no VAT. Booking only one leg leaves the suspense account out of balance. ' +
      'NOTE for a SUPPLIER REFUND with VAT (money back on an expense you already booked): put the ' +
      'row on the ORIGINAL EXPENSE ledger, not on a revenue ledger, so the cost reverses; the VAT ' +
      'code must still be a sale code (see above). Be aware this books the VAT to the output-VAT ' +
      'account rather than reducing input VAT — the net amount payable on the return is the same, ' +
      'but it lands in a different box. Whether that presentation is acceptable is a question for ' +
      'an accountant, not an API constraint.',
    bankHint: 'Bank/cash ledger id the money arrived in (category FIN).',
    ledgerHint: `Counter-account ledger id for this line (e.g. revenue VW, or a BAL suspense account). ${ROW_LEDGER_RESTRICTION}`,
    vatHint:
      'Sale VAT code (HOOG_VERK_21, LAAG_VERK_9, VERL_VERK, GEEN, …). A purchase code is expected ' +
      'to fail with MUT_111 ("VAT code must be of type sale") — inferred from the error wording, ' +
      'not documented per mutation type.',
    rowsHint: 'One or more counter-account lines.',
  });
}
