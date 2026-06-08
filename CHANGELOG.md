# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-06-08

### Added

- **First write tool** `create_purchase_mutation` for booking purchase
  invoices (type 1, _Factuur ontvangen_) via `POST /v1/mutation`, guarded by
  two safety layers: the `EBOEKHOUDEN_ALLOW_WRITES` environment gate
  (read-only by default) and a dry-run that requires `confirm: true` to
  actually book.
- Auto-fill of `termOfPayment` from the relation, with a
  `termOfPaymentDefault` fallback; the resolved `termOfPaymentSource` is
  reported back.
- `EBOEKHOUDEN_ALLOW_WRITES` documented in `.env.example`; write status is
  now surfaced in the startup log (tool count 19 → 20).

## [0.1.0] - 2026-06-01

Initial read-only release built on the e-Boekhouden REST API
(`api.e-boekhouden.nl`, OpenAPI v1).

### Added

- **REST client** (`EboekhoudenClient`) with API-token → session-token
  exchange, per-administration session caching with automatic renewal,
  `limit`/`offset` pagination, and 401 retry.
- **Multi-administration support** via a `label → { apiToken, source }`
  credentials file (`~/.e-boekhouden/credentials.json`), with a single-token
  environment fallback.
- **Auth tools**: `whoami`, `reload_credentials`.
- **Administration tools**: `list_administrations`, `get_linked_administrations`.
- **Ledger tools**: `get_ledgers`, `get_ledger`, `get_ledger_balances`,
  `get_ledger_balance`.
- **Relation tools**: `get_relations`, `get_relation`.
- **Mutation tools**: `get_mutations`, `get_mutation`,
  `get_outstanding_invoices`.
- **Invoice tools**: `get_invoices`, `get_invoice`.
- **Master-data tools**: `get_products`, `get_product_groups`,
  `get_cost_centers`, `get_units`.
- Standalone probe scripts: `npm run whoami`, `npm run list-administrations`.

[Unreleased]: https://github.com/CodeMill-Solutions/e-boekhouden-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/CodeMill-Solutions/e-boekhouden-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CodeMill-Solutions/e-boekhouden-mcp/releases/tag/v0.1.0
