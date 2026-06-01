#!/usr/bin/env tsx
/**
 * Standalone list-administrations probe — calls GET /v1/administration and
 * prints the raw result. Validates the session + Bearer auth assumptions in
 * one shot.
 *
 * Usage:
 *   npx tsx scripts/list-administrations.ts [administration]
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

  console.log(`Listing administrations via "${administration}"\n`);
  const client = new EboekhoudenClient(administration, map);

  const raw = await client.request({ administration, path: '/administration' });
  console.log(JSON.stringify(raw, null, 2));
}

main().catch((err) => {
  console.error('\nlist-administrations probe failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
