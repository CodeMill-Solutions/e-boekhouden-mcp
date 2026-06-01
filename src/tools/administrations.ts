import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EboekhoudenClient, type ListResponse } from '../eboekhouden-client.js';
import { ok, guard } from './result.js';

/**
 * Register administration tools.
 *
 * In e-Boekhouden an **administration** ("administratie") is the bookkeeping
 * entity an API token belongs to. `list_administrations` is the canonical
 * "what can this token see?" call and doubles as the structural smoke test for
 * the session flow — a working response proves the token, session exchange,
 * and Bearer auth are all correct.
 *
 * Endpoints:
 *   - GET /v1/administration         → administrations managed by this token
 *   - GET /v1/administration/linked  → administrations linked to the current one
 */
export function registerAdministrationTools(server: McpServer, client: EboekhoudenClient): void {
  server.registerTool(
    'list_administrations',
    {
      description:
        'List all e-Boekhouden administrations accessible with the current API token. Each item ' +
        'has a `guid` and `company` name. NOTE: this endpoint is accountant-only — a regular ' +
        'single-administration token returns error EP_001. Calls GET /v1/administration.',
      inputSchema: {
        administration: z
          .string()
          .optional()
          .describe('Credentials label selecting which API token to use. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
      },
    },
    async ({ administration }) =>
      guard(async () => {
        const data = await client.request<ListResponse<unknown>>({
          administration,
          path: '/administration',
        });
        const items = data?.items ?? [];
        return ok({ count: data?.count ?? items.length, administrations: items });
      }),
  );

  server.registerTool(
    'get_linked_administrations',
    {
      description:
        'List e-Boekhouden administrations linked to the current administration (accountant / ' +
        'multi-entity scenarios). Accountant-only, like `list_administrations`. ' +
        'Calls GET /v1/administration/linked.',
      inputSchema: {
        administration: z
          .string()
          .optional()
          .describe('Credentials label selecting which API token to use. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
      },
    },
    async ({ administration }) =>
      guard(async () => {
        const data = await client.request<ListResponse<unknown>>({
          administration,
          path: '/administration/linked',
        });
        const items = data?.items ?? [];
        return ok({ count: data?.count ?? items.length, administrations: items });
      }),
  );
}
