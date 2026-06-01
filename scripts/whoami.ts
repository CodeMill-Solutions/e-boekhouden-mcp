#!/usr/bin/env tsx
/**
 * Standalone whoami probe — exercises the API-token → session → administration
 * chain without going through the MCP transport. The Phase-1 go/no-go gate.
 *
 * Usage:
 *   npx tsx scripts/whoami.ts [administration]
 */
import 'dotenv/config';
import { EboekhoudenClient, resolveCredentials } from '../src/eboekhouden-client.js';

async function main(): Promise<void> {
  const { defaultAdministration, map, credentialsFilePath } = resolveCredentials();

  if (map.size === 0) {
    console.error(
      `No credentials found (looked at ${credentialsFilePath}) and no EBOEKHOUDEN_API_TOKEN in the environment.`,
    );
    process.exit(1);
  }

  const administration = process.argv[2] ?? defaultAdministration ?? map.keys().next().value ?? '';

  console.log(`Probing e-Boekhouden auth for administration "${administration}"\n`);
  const client = new EboekhoudenClient(administration, map);

  // 1. Session — the cheapest proof the API token is valid.
  await client.getSessionToken(administration);
  console.log('✓ Session started — API token is valid.\n');

  // 2. /administration — accountant-only; informative but not required.
  try {
    const admins = await client.request<{ items?: unknown[]; count?: number }>({
      administration,
      path: '/administration',
    });
    console.log('✓ Accountant token — accessible administrations:');
    console.log(JSON.stringify(admins, null, 2), '\n');
  } catch (err) {
    console.log(`• /administration not available (single-administration token): ${err instanceof Error ? err.message : err}\n`);
  }

  // 3. A real business read — proves the Bearer session works on data endpoints.
  const ledgers = await client.request<{ items?: unknown[]; count?: number }>({
    administration,
    path: '/ledger',
    query: { limit: 3 },
  });
  const count = ledgers?.count ?? ledgers?.items?.length ?? 0;
  console.log(`✓ Business read works — GET /ledger returned ${count} ledger account(s). First few:`);
  console.log(JSON.stringify(ledgers?.items ?? [], null, 2));
}

main().catch((err) => {
  console.error('\nwhoami probe failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
