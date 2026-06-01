import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EboekhoudenClient, loadCredentialsFile, type AdministrationCredentials } from '../eboekhouden-client.js';
import { ok, fail, guard } from './result.js';

/**
 * Register the auth / setup tools.
 *
 * `whoami` is the smallest end-to-end auth check we can make: it starts a
 * session (proving the API token is valid) and lists the administrations the
 * token can see. It's the Phase-1 go/no-go gate before the broader read-tools
 * are trusted.
 *
 * `reload_credentials` mirrors the sibling MCP servers: re-read the JSON
 * credentials file from disk and swap the in-memory map in place. Sessions for
 * administrations whose credentials changed (or were removed) are evicted so
 * the next call re-authenticates.
 */
export function registerAuthTools(server: McpServer, client: EboekhoudenClient): void {
  server.registerTool(
    'whoami',
    {
      description:
        'Validate e-Boekhouden authentication: start a session (proving the API token is valid) ' +
        'and confirm a business read works. Run this first to verify setup end-to-end before ' +
        'invoking other tools. Also reports whether the token is an accountant token (with access ' +
        'to multiple administrations) or a single-administration token.',
      inputSchema: {
        administration: z
          .string()
          .optional()
          .describe('Administration label to validate. Defaults to EBOEKHOUDEN_ADMINISTRATION when omitted.'),
      },
    },
    async ({ administration }) =>
      guard(async () => {
        // 1. Starting a session is the cheapest proof the token is valid.
        await client.getSessionToken(administration);
        const resolved = administration ?? client.defaultAdministrationName;

        // 2. GET /v1/administration is accountant-only; use it to classify the
        //    token, but don't let a non-accountant 400 mask a valid session.
        let accountant = false;
        let administrations: unknown[] | undefined;
        try {
          const admins = await client.request<{ items?: unknown[]; count?: number }>({
            administration,
            path: '/administration',
          });
          accountant = true;
          administrations = admins?.items ?? [];
        } catch {
          accountant = false;
        }

        // 3. A real business read proves the Bearer session works on data endpoints.
        const ledgers = await client.request<{ items?: unknown[]; count?: number }>({
          administration,
          path: '/ledger',
          query: { limit: 1 },
        });

        return ok({
          administration: resolved,
          sessionStarted: true,
          tokenType: accountant ? 'accountant' : 'single-administration',
          ...(administrations ? { administrations } : {}),
          businessReadOk: true,
          ledgerSample: ledgers?.items ?? [],
        });
      }),
  );

  server.registerTool(
    'reload_credentials',
    {
      description:
        'Reload the administration → API-token credentials map from the JSON credentials file ' +
        'without restarting the MCP server. Sessions for changed/removed administrations are ' +
        'invalidated; unchanged ones keep their cached session. Returns a diff of ' +
        'added/updated/removed administration labels.',
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            'Optional explicit path to the credentials JSON file. ' +
              'Defaults to EBOEKHOUDEN_CREDENTIALS_FILE → ~/.e-boekhouden/credentials.json → ./credentials.json.',
          ),
      },
    },
    async ({ path }) =>
      guard(async () => {
        const loaded = loadCredentialsFile(path);
        if (!loaded.found) {
          return fail(`Credentials file not found at ${loaded.path}`, { source: loaded.path });
        }

        const diff = client.reloadCredentials(loaded.map as Map<string, AdministrationCredentials>);
        return ok({
          source: loaded.path,
          added: diff.added,
          updated: diff.updated,
          removed: diff.removed,
          total: diff.total,
          unchanged: diff.total - diff.added.length - diff.updated.length,
        });
      }),
  );
}
