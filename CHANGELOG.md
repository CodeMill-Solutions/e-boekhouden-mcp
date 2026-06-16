# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-06-16

### Added

- **`create_payment` `direction`** — `"received"` registers a payment received on
  a SALES invoice (type 3, Factuurbetaling ontvangen, books against the debtor
  account); `"sent"` (default) keeps the existing purchase-invoice behaviour
  (type 4). The counter account is auto-resolved from the single CRED/DEB ledger.
- **`create_sales_invoice` processing** — the invoice is now processed into the
  accounting by default (the "Factuur direct verwerken in de boekhouding"
  option) by sending a `mutation` object with the debtor ledger, so it is
  journaled and becomes an open post. New `process: false` creates a concept
  invoice; the debtor ledger is auto-resolved or set via `debtorLedgerId` /
  `EBOEKHOUDEN_DEBTOR_LEDGER_ID`.

### Changed

- `create_payment`: the optional `creditorLedgerId` parameter is renamed to
  `contraLedgerId` (creditor for `sent`, debtor for `received`).

## [0.3.0] - 2026-06-09

Adds a set of human-in-the-loop **write tools**. Every write tool is disabled
unless `EBOEKHOUDEN_ALLOW_WRITES` is truthy, and runs as a dry-run until called
with `confirm: true`.

### Added

- **`create_relation`** — create a supplier/customer (POST /v1/relation).
- **`create_payment`** — register a payment against a purchase invoice (mark it
  paid) as a type 4 mutation; links by `invoiceNumber` + `relationId` on the row.
- **`create_money_spent`** — book an expense paid directly, without a purchase
  invoice (type 6, *Geld uitgegeven*).
- **`create_sales_invoice`** — create a sales invoice (POST /v1/invoice). The
  administration-specific `templateId` and revenue ledger are supplied per call
  or via `EBOEKHOUDEN_INVOICE_TEMPLATE_ID`, `EBOEKHOUDEN_REVENUE_LEDGER_ID` and
  `EBOEKHOUDEN_DEFAULT_UNIT_ID`.

### Changed

- Shared write helpers (`write-helpers.ts`): a single `gatedWrite` applies the
  env gate + dry-run/confirm guards across all write tools; shared
  `resolveTermOfPayment` and ledger-resolution helpers.

## [0.2.0] - 2026-06-08

### Added

- **`create_purchase_mutation`** — the first write tool: book a purchase invoice
  (inkoopfactuur) as a type 1 mutation, behind the `EBOEKHOUDEN_ALLOW_WRITES`
  env gate with dry-run/confirm. Auto-fills `termOfPayment` from the relation
  (with a `termOfPaymentDefault` fallback), reported as `termOfPaymentSource`.

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

[Unreleased]: https://github.com/CodeMill-Solutions/e-boekhouden-mcp/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/CodeMill-Solutions/e-boekhouden-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/CodeMill-Solutions/e-boekhouden-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/CodeMill-Solutions/e-boekhouden-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CodeMill-Solutions/e-boekhouden-mcp/releases/tag/v0.1.0
