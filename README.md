# e-Boekhouden MCP

[![npm](https://img.shields.io/npm/v/@codemill-solutions/e-boekhouden-mcp)](https://www.npmjs.com/package/@codemill-solutions/e-boekhouden-mcp)

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[e-Boekhouden](https://www.e-boekhouden.nl) **REST API**. It lets MCP clients
(Claude, CodeMill, …) read your bookkeeping data — administrations, ledgers,
relations, mutations, invoices and master data — through a small set of typed
tools.

> Built on the modern REST API (`api.e-boekhouden.nl`, OpenAPI v1), **not** the
> legacy SOAP API. v0.1.0 is **read-only**; write tools (creating mutations,
> invoices, relations) are planned for a later release.

---

## How it works

e-Boekhouden's REST auth is refreshingly simple:

1. You create a secret **API token** in your administration
   (*Beheer → Instellingen → API/SOAP*).
2. The server exchanges that token for a short-lived **session token**
   (`POST /v1/session`) and caches it, renewing automatically before it
   expires.
3. Every business call sends `Authorization: Bearer <session-token>`.

An API token belongs to one administration, so the token *is* the
administration selector. To serve several administrations, give each one a
label in a credentials file (see below).

---

## Installation

```bash
npm install -g @codemill-solutions/e-boekhouden-mcp
```

Or run it straight from a clone:

```bash
git clone https://github.com/CodeMill-Solutions/e-boekhouden-mcp.git
cd e-boekhouden-mcp
npm install
npm run build
```

### Requirements

- Node.js 20+
- An e-Boekhouden account with an API token

---

## Setup

### 1. Configure credentials

**Single administration (env vars)** — copy `.env.example` to `.env`:

```dotenv
EBOEKHOUDEN_API_TOKEN=your-secret-api-token
EBOEKHOUDEN_ADMINISTRATION=demo        # optional label (defaults to "default")
EBOEKHOUDEN_SOURCE=codemill            # max 10 chars, optional
```

**Multiple administrations (credentials file)** — create
`~/.e-boekhouden/credentials.json`:

```json
{
  "demo":        { "apiToken": "token-for-demo", "source": "codemill" },
  "acme-bv":     { "apiToken": "token-for-acme", "source": "codemill" }
}
```

Path precedence: `EBOEKHOUDEN_CREDENTIALS_FILE` →
`~/.e-boekhouden/credentials.json` → `./credentials.json`. The label (`demo`,
`acme-bv`, …) is what you pass as the optional `administration` argument to any
tool; omit it to use the default (`EBOEKHOUDEN_ADMINISTRATION`).

### 2. Verify the connection

```bash
npm run whoami                 # starts a session + lists administrations
npm run list-administrations   # raw GET /v1/administration
```

If `whoami` returns your administration(s), you're ready.

### 3. Connect from an MCP client

```json
{
  "mcpServers": {
    "e-boekhouden": {
      "command": "node",
      "args": ["/absolute/path/to/e-boekhouden-mcp/dist/index.js"],
      "env": {
        "EBOEKHOUDEN_API_TOKEN": "your-secret-api-token",
        "EBOEKHOUDEN_ADMINISTRATION": "demo"
      }
    }
  }
}
```

---

## Multi-administration support

- Credentials live in a JSON file (`label → { apiToken, source }`); the default
  administration can also come from env vars as a local-dev fallback.
- Every tool accepts an optional `administration` argument selecting which
  token to use.
- Session tokens are cached per administration and renewed automatically.
- `reload_credentials` re-reads the file at runtime without restarting the
  server; sessions for changed/removed administrations are invalidated, others
  stay warm.

---

## Available tools (19)

### Auth & setup
| Tool | Description |
|---|---|
| `whoami` | Validate auth: start a session + list accessible administrations. |
| `reload_credentials` | Reload the credentials file at runtime; returns an added/updated/removed diff. |

### Administrations
| Tool | Description |
|---|---|
| `list_administrations` | Administrations the token can access. *(accountant tokens only)* |
| `get_linked_administrations` | Administrations linked to the current one. *(accountant tokens only)* |

> A regular single-administration token cannot call the administration
> endpoints (the API returns `EP_001`). `whoami` reports which kind of token you
> have.

### Ledgers (grootboek)
| Tool | Description |
|---|---|
| `get_ledgers` | List GL accounts (filter by code/category). |
| `get_ledger` | Single GL account by id. |
| `get_ledger_balances` | Balances across accounts for a period. |
| `get_ledger_balance` | Balance of a single account. |

### Relations (relaties)
| Tool | Description |
|---|---|
| `get_relations` | List customers/suppliers (filter by code, type, name, …). |
| `get_relation` | Single relation by id. |

### Mutations (mutaties / boekingen)
| Tool | Description |
|---|---|
| `get_mutations` | List bookkeeping entries (filter by type, invoiceNumber, …). |
| `get_mutation` | Single mutation with booking lines. |
| `get_outstanding_invoices` | Outstanding invoices (openstaande posten); requires `credDeb` = `D` (receivables) or `C` (payables). |

### Invoices (verkoopfacturen)
| Tool | Description |
|---|---|
| `get_invoices` | List sales invoices. |
| `get_invoice` | Single sales invoice with lines. |

### Master data
| Tool | Description |
|---|---|
| `get_products` | Products/articles. |
| `get_product_groups` | Product groups. |
| `get_cost_centers` | Cost centers (kostenplaatsen). |
| `get_units` | Units of measure. |

List tools are auto-paginated (`limit`/`offset`) and accept a `maxItems` cap.

---

## Testing

```bash
npm run dev        # run from TypeScript source (tsx)
npm run inspect    # open the MCP Inspector against the built server
npm run whoami     # standalone auth probe
```

---

## Architecture

```
src/
  index.ts                 # MCP wiring: credentials merge, tool registration, stdio transport
  eboekhouden-client.ts    # REST client: session cache, request(), pagination, error mapping
  tools/
    result.ts              # shared ok()/fail()/guard() result helpers
    auth.ts                # whoami, reload_credentials
    administrations.ts     # list_administrations, get_linked_administrations
    ledgers.ts             # get_ledger(s), balances
    relations.ts           # get_relation(s)
    mutations.ts           # get_mutation(s), outstanding invoices
    invoices.ts            # get_invoice(s)
    masterdata.ts          # products, product groups, cost centers, units
scripts/
  whoami.ts                # standalone auth probe
  list-administrations.ts  # standalone GET /v1/administration probe
```

All tools go through `EboekhoudenClient.request()`, which transparently
acquires/renews the session token and retries once on a 401.

---

## Roadmap

- **v0.1** — read-only MVP (this release).
- **v0.2** — write tools: create mutations, invoices, relations, ledgers,
  products, cost centers.

---

## About CodeMill

This project is built and maintained by [**CodeMill
Solutions**](https://codemill.dev), a Dutch software development agency
specializing in custom web applications, API integrations, mobile apps, and AI
agents & automation for small and medium-sized businesses.

Founded by engineers with 20+ years of combined experience, CodeMill favors
short communication lines, direct client relationships, and open-source
foundations to avoid vendor lock-in. A recurring focus is connecting accounting
and ERP systems to modern AI workflows — this MCP server sits alongside sibling
projects such as
[`@codemill-solutions/yuki-mcp`](https://www.npmjs.com/package/@codemill-solutions/yuki-mcp)
and
[`@codemill-solutions/twinfield-mcp`](https://www.npmjs.com/package/@codemill-solutions/twinfield-mcp),
bringing Dutch accounting platforms within reach of AI agents.

Based in Noord-Brabant and Overijssel (Netherlands), working bilingually in
Dutch and English across the Netherlands and the broader European market.

📧 Interested in a custom integration? Reach out via [codemill.dev](https://codemill.dev).

---

## License

MIT © CodeMill Solutions B.V.
