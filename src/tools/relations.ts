import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EboekhoudenClient } from '../eboekhouden-client.js';
import { ok, guard } from './result.js';

/**
 * Register relation (relaties) read tools.
 *
 * In e-Boekhouden a **relation** is a contact that can be a customer and/or a
 * supplier — the distinction is carried by the `type` field rather than by
 * separate endpoints.
 *
 * Endpoints:
 *   - GET /v1/relation       → list, with filters (code, type, email, name, city, …)
 *   - GET /v1/relation/{id}  → single relation
 */
export function registerRelationTools(server: McpServer, client: EboekhoudenClient): void {
  server.registerTool(
    'get_relations',
    {
      description:
        'List relations (relaties — customers and/or suppliers). Each item has id, type and ' +
        'code; filter by code, type, email, name, contact or city. Auto-paginated. ' +
        'Calls GET /v1/relation.',
      inputSchema: {
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
        code: z.string().optional().describe('Filter by relation code.'),
        type: z.string().optional().describe('Filter by relation type.'),
        email: z.string().optional().describe('Filter by email address.'),
        name: z.string().optional().describe('Filter by (partial) name.'),
        contact: z.string().optional().describe('Filter by contact person.'),
        city: z.string().optional().describe('Filter by city.'),
        maxItems: z.number().int().positive().optional().describe('Cap on total items returned (default 1000).'),
      },
    },
    async ({ administration, code, type, email, name, contact, city, maxItems }) =>
      guard(async () => {
        const items = await client.paginate('/relation', {
          administration,
          query: { code, type, email, name, contact, city },
          maxItems,
        });
        return ok({ count: items.length, relations: items });
      }),
  );

  server.registerTool(
    'get_relation',
    {
      description: 'Read a single relation by its numeric id, including full contact details. Calls GET /v1/relation/{id}.',
      inputSchema: {
        id: z.number().int().describe('Numeric relation id.'),
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
      },
    },
    async ({ id, administration }) =>
      guard(async () => {
        const relation = await client.request({ administration, path: `/relation/${id}` });
        return ok({ relation });
      }),
  );
}
