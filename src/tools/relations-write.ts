import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EboekhoudenClient } from '../eboekhouden-client.js';
import { guard } from './result.js';
import { compact, gatedWrite } from './write-helpers.js';

/**
 * Register relation (relaties) write tools.
 *
 * Same two safety layers as the other write tools:
 *   1. Environment gate — refused unless EBOEKHOUDEN_ALLOW_WRITES is truthy.
 *   2. Dry-run by default — only creates when `confirm: true` is passed.
 *
 * Endpoint: POST /v1/relation. Field names mirror the read shape returned by
 * GET /v1/relation/{id}. The API requires at least `name`; `type` must be
 * "B" (company/business) or "P" (person).
 */
export function registerRelationWriteTools(server: McpServer, client: EboekhoudenClient): void {
  server.registerTool(
    'create_relation',
    {
      description:
        'Create a relation (relatie — supplier or customer) via POST /v1/relation. ' +
        'WRITE TOOL — disabled unless the server has EBOEKHOUDEN_ALLOW_WRITES=true. ' +
        'Dry-run by default: it only creates when `confirm: true` is passed; otherwise it ' +
        'returns the exact body it would send so you can review it first. ' +
        'Required: `name`. `type` is "B" (company) or "P" (person), default "B". ' +
        'Optionally set a default cost `ledgerId` and `termOfPayment` so future purchase ' +
        'mutations can auto-fill them. Returns the created relation (including its id).',
      inputSchema: {
        name: z.string().min(1).describe('Relation name (required), e.g. "Any Lamp B.V.".'),
        type: z.enum(['B', 'P']).optional().describe('"B" company (default) or "P" person.'),
        code: z.string().optional().describe('Short relation code/label, e.g. "Lampdirect".'),
        emailAddress: z.string().optional().describe('Email address.'),
        vatNumber: z.string().optional().describe('VAT number (btw-nummer).'),
        companyRegistrationNumber: z.string().optional().describe('KvK / company registration number (numeric).'),
        iban: z.string().optional().describe('IBAN.'),
        bic: z.string().optional().describe('BIC.'),
        address: z.string().optional().describe('Street address.'),
        postalCode: z.string().optional().describe('Postal code.'),
        city: z.string().optional().describe('City.'),
        country: z.string().optional().describe('Country.'),
        phoneNumber: z.string().optional().describe('Phone number.'),
        website: z.string().optional().describe('Website.'),
        note: z.string().optional().describe('Free-text note.'),
        ledgerId: z
          .number()
          .int()
          .optional()
          .describe('Default cost/ledger account id for this relation (category VW or BAL).'),
        termOfPayment: z.number().int().optional().describe('Default payment term in days.'),
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
    async ({ confirm, administration, type, ...fields }) =>
      guard(async () => {
        const body = compact({ type: type ?? 'B', ...fields });
        return gatedWrite({
          confirm,
          statusKey: 'created',
          plannedKey: 'plannedRelation',
          resultKey: 'relation',
          body,
          execute: () => client.request({ administration, method: 'POST', path: '/relation', body }),
        });
      }),
  );
}
