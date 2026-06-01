import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EboekhoudenClient, type ListResponse } from '../eboekhouden-client.js';
import { ok, guard } from './result.js';

/**
 * Register master-data read tools: products (artikelen), cost centers
 * (kostenplaatsen) and units (eenheden). These are the lookup tables invoices
 * and mutations reference.
 *
 * Endpoints:
 *   - GET /v1/product          → list, filter by code/groupCode
 *   - GET /v1/product/{id}     → single product
 *   - GET /v1/product/groups   → product groups
 *   - GET /v1/costcenter       → list, filter by parentId/description
 *   - GET /v1/unit             → units of measure
 */
export function registerMasterDataTools(server: McpServer, client: EboekhoudenClient): void {
  server.registerTool(
    'get_products',
    {
      description:
        'List products/articles (artikelen). Filter by code or groupCode. Auto-paginated. ' +
        'Calls GET /v1/product.',
      inputSchema: {
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
        code: z.string().optional().describe('Filter by product code.'),
        groupCode: z.string().optional().describe('Filter by product group code.'),
        maxItems: z.number().int().positive().optional().describe('Cap on total items returned (default 1000).'),
      },
    },
    async ({ administration, code, groupCode, maxItems }) =>
      guard(async () => {
        const items = await client.paginate('/product', {
          administration,
          query: { code, groupCode },
          maxItems,
        });
        return ok({ count: items.length, products: items });
      }),
  );

  server.registerTool(
    'get_product_groups',
    {
      description: 'List product groups (artikelgroepen). Calls GET /v1/product/groups.',
      inputSchema: {
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
      },
    },
    async ({ administration }) =>
      guard(async () => {
        const data = await client.request<ListResponse<unknown>>({ administration, path: '/product/groups' });
        const items = data?.items ?? [];
        return ok({ count: data?.count ?? items.length, groups: items });
      }),
  );

  server.registerTool(
    'get_cost_centers',
    {
      description:
        'List cost centers (kostenplaatsen). Filter by parentId or description. Auto-paginated. ' +
        'Calls GET /v1/costcenter.',
      inputSchema: {
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
        parentId: z.string().optional().describe('Filter by parent cost-center id.'),
        description: z.string().optional().describe('Filter by (partial) description.'),
        maxItems: z.number().int().positive().optional().describe('Cap on total items returned (default 1000).'),
      },
    },
    async ({ administration, parentId, description, maxItems }) =>
      guard(async () => {
        const items = await client.paginate('/costcenter', {
          administration,
          query: { parentId, description },
          maxItems,
        });
        return ok({ count: items.length, costCenters: items });
      }),
  );

  server.registerTool(
    'get_units',
    {
      description: 'List units of measure (eenheden) used on products and invoice lines. Calls GET /v1/unit.',
      inputSchema: {
        administration: z.string().optional().describe('Credentials label. Defaults to EBOEKHOUDEN_ADMINISTRATION.'),
      },
    },
    async ({ administration }) =>
      guard(async () => {
        const data = await client.request<ListResponse<unknown>>({ administration, path: '/unit' });
        const items = data?.items ?? [];
        return ok({ count: data?.count ?? items.length, units: items });
      }),
  );
}
