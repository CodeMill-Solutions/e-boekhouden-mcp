import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EboekhoudenClient, resolveCredentials } from './eboekhouden-client.js';
import { registerAuthTools } from './tools/auth.js';
import { registerAdministrationTools } from './tools/administrations.js';
import { registerLedgerTools } from './tools/ledgers.js';
import { registerRelationTools } from './tools/relations.js';
import { registerRelationWriteTools } from './tools/relations-write.js';
import { registerMutationTools } from './tools/mutations.js';
import { registerMutationWriteTools } from './tools/mutations-write.js';
import { registerInvoiceTools } from './tools/invoices.js';
import { registerInvoiceWriteTools } from './tools/invoices-write.js';
import { registerMasterDataTools } from './tools/masterdata.js';
import { writesEnabled } from './tools/write-helpers.js';

// ── Credentials ───────────────────────────────────────────────────────────────
//
// Credentials come from a JSON file (label → { apiToken, source }) and/or the
// environment. The merge + fallback logic lives in `resolveCredentials()` so
// the server, the probe scripts, and `reload_credentials` all behave the same.
//
// File format (~/.e-boekhouden/credentials.json):
//   {
//     "<administration label>": { "apiToken": "...", "source": "codemill" },
//     ...
//   }

const { defaultAdministration, map: credentialsMap, credentialsFilePath, fileFound } = resolveCredentials();

if (fileFound) {
  process.stderr.write(
    `[e-boekhouden-mcp] Loaded credentials for ${credentialsMap.size} administration(s) from ${credentialsFilePath}\n`,
  );
}

if (credentialsMap.size === 0) {
  process.stderr.write(
    '[e-boekhouden-mcp] Warning: no e-Boekhouden credentials configured.\n' +
      '           Set EBOEKHOUDEN_API_TOKEN (EBOEKHOUDEN_ADMINISTRATION is optional),\n' +
      '           or place a credentials.json at ~/.e-boekhouden/credentials.json.\n',
  );
}

// ── e-Boekhouden REST client ────────────────────────────────────────────────

const client = new EboekhoudenClient(defaultAdministration, credentialsMap);

// ── MCP server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'e-boekhouden-mcp',
  version: '0.3.0',
});

registerAuthTools(server, client);
registerAdministrationTools(server, client);
registerLedgerTools(server, client);
registerRelationTools(server, client);
registerRelationWriteTools(server, client);
registerMutationTools(server, client);
registerMutationWriteTools(server, client);
registerInvoiceTools(server, client);
registerInvoiceWriteTools(server, client);
registerMasterDataTools(server, client);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();

await server.connect(transport);

const credInfo =
  credentialsMap.size > 0
    ? `${credentialsMap.size} administration credential set(s) loaded`
    : 'no credentials configured';

const writesAllowed = writesEnabled();

process.stderr.write(
  `[e-boekhouden-mcp] Server started — 24 tools registered ` +
    `(whoami, reload_credentials, list_administrations, get_linked_administrations, ` +
    `get_ledgers, get_ledger, get_ledger_balances, get_ledger_balance, ` +
    `get_relations, get_relation, create_relation, get_mutations, get_mutation, ` +
    `get_outstanding_invoices, get_invoices, get_invoice, create_sales_invoice, get_products, ` +
    `get_product_groups, get_cost_centers, get_units, create_purchase_mutation, create_payment, ` +
    `create_money_spent). ` +
    `Writes: ${writesAllowed ? 'ENABLED (EBOEKHOUDEN_ALLOW_WRITES)' : 'disabled (read-only)'}. ` +
    `Default administration: ${defaultAdministration || '(none)'} — ${credInfo}\n`,
);
