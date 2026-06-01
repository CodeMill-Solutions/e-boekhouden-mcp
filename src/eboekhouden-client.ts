import axios, { AxiosError, type Method } from 'axios';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ── e-Boekhouden REST API ──────────────────────────────────────────────────────
//
// Source: https://api.e-boekhouden.nl/swagger/index.html (OpenAPI 3.0.4, "v1").
// Verified 2026-06.
//
// This is the modern REST/JSON API. The older SOAP API
// (soap.e-boekhouden.nl/soap.asmx) is intentionally NOT used.
//
// Auth model (much simpler than an OAuth2 dance):
//   1. POST /v1/session  { accessToken: <API-token>, source: <code> }
//        → { token: <session-token>, expiresIn: <seconds> }
//   2. Send `Authorization: Bearer <session-token>` on every other request.
//   3. DELETE /v1/session  ends the session.
//
// The API token is created per administration in e-Boekhouden's settings, so a
// token implicitly selects its administration — there is no per-request office
// header. Multi-administration support is therefore a map of
// `administration label → { apiToken, source }`.

export const EBOEKHOUDEN_BASE_URL = 'https://api.e-boekhouden.nl';
export const EBOEKHOUDEN_API_VERSION = 'v1';

/** Default `source` integration identifier (max 10 chars, [A-Za-z0-9_ ]). */
export const EBOEKHOUDEN_DEFAULT_SOURCE = 'codemill';

/** Validate a `source` value against the API constraint `^[\w_ ]{1,10}$`. */
export function isValidSource(source: string): boolean {
  return /^[\w ]{1,10}$/.test(source);
}

// ── Credentials file loading ────────────────────────────────────────────────
//
// Resolve which JSON file holds the administration → credentials map, with the
// same precedence the sibling MCP servers use:
//   1. EBOEKHOUDEN_CREDENTIALS_FILE environment variable (explicit path)
//   2. ~/.e-boekhouden/credentials.json  (default user-level location)
//   3. ./credentials.json  (local fallback for development)

export interface AdministrationCredentials {
  /** Secret API token created in the e-Boekhouden administration settings. */
  apiToken: string;
  /** Optional integration identifier; defaults to EBOEKHOUDEN_DEFAULT_SOURCE. */
  source?: string;
}

export interface LoadedCredentials {
  /** Absolute path that was read from. */
  path: string;
  /** Map of administration label → credentials. Empty if the file did not exist. */
  map: Map<string, AdministrationCredentials>;
  /** True when the resolved file existed and was parsed. */
  found: boolean;
}

export function resolveCredentialsFilePath(explicitPath?: string): string {
  if (explicitPath) return explicitPath;
  if (process.env['EBOEKHOUDEN_CREDENTIALS_FILE']) return process.env['EBOEKHOUDEN_CREDENTIALS_FILE'];
  const userPath = join(homedir(), '.e-boekhouden', 'credentials.json');
  if (existsSync(userPath)) return userPath;
  return 'credentials.json';
}

export function loadCredentialsFile(explicitPath?: string): LoadedCredentials {
  const path = resolveCredentialsFilePath(explicitPath);
  const map = new Map<string, AdministrationCredentials>();
  if (!existsSync(path)) {
    return { path, map, found: false };
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, AdministrationCredentials>;
  for (const [name, creds] of Object.entries(raw)) {
    if (!name || !creds || !creds.apiToken) continue;
    map.set(name, { apiToken: creds.apiToken, source: creds.source });
  }
  return { path, map, found: true };
}

/** Fallback administration label used when only a bare API token is provided. */
export const DEFAULT_ADMINISTRATION_LABEL = 'default';

export interface ResolvedCredentials {
  /** Administration label to use when a tool omits `administration`. */
  defaultAdministration: string;
  /** Merged map of administration label → credentials (file + env). */
  map: Map<string, AdministrationCredentials>;
  /** Path the credentials file was resolved to. */
  credentialsFilePath: string;
  /** True when that file existed and was parsed. */
  fileFound: boolean;
}

/**
 * Resolve the full credentials picture from the environment + credentials file,
 * applying the precedence and fallbacks shared by the server and the probe
 * scripts:
 *
 *   1. Load `credentials.json` (label → { apiToken, source }).
 *   2. If `EBOEKHOUDEN_API_TOKEN` is set, register it under
 *      `EBOEKHOUDEN_ADMINISTRATION` — or, when that label is empty, under
 *      `"default"`. The token alone is enough to authenticate; the label is
 *      only a local selector.
 *   3. The default administration is the env label (if any), otherwise the
 *      first entry in the file.
 */
export function resolveCredentials(): ResolvedCredentials {
  const loaded = loadCredentialsFile();
  const map = loaded.map;

  const envToken = process.env['EBOEKHOUDEN_API_TOKEN'] ?? '';
  const envSource = process.env['EBOEKHOUDEN_SOURCE'] || undefined;
  let defaultAdministration = process.env['EBOEKHOUDEN_ADMINISTRATION'] ?? '';

  if (envToken) {
    const label = defaultAdministration || DEFAULT_ADMINISTRATION_LABEL;
    if (!map.has(label)) {
      map.set(label, { apiToken: envToken, source: envSource });
    }
    defaultAdministration = label;
  }

  if (!defaultAdministration && map.size > 0) {
    defaultAdministration = map.keys().next().value ?? '';
  }

  return { defaultAdministration, map, credentialsFilePath: loaded.path, fileFound: loaded.found };
}

/**
 * Diff returned by `EboekhoudenClient.reloadCredentials` so callers can report
 * what changed — used by the `reload_credentials` MCP tool.
 */
export interface CredentialsReloadDiff {
  added: string[];
  updated: string[];
  removed: string[];
  total: number;
}

// ── Session token cache ──────────────────────────────────────────────────────

interface CachedSession {
  token: string;
  /** Epoch ms after which the session token is considered expired. */
  expiresAt: number;
}

/** Renew ~30s before the real expiry to absorb clock skew + in-flight calls. */
const SESSION_RENEW_LEEWAY_MS = 30_000;

/** Fallback session lifetime (s) when the API omits `expiresIn`. */
const DEFAULT_SESSION_TTL_SEC = 3600;

const REQUEST_TIMEOUT_MS = 30_000;

export interface RequestOptions {
  /** Administration label selecting which credentials/session to use. */
  administration?: string;
  method?: Method;
  /** Path below the version prefix, e.g. `/administration` or `/ledger/123`. */
  path: string;
  /** Query-string parameters; undefined/empty values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON request body for POST/PATCH. */
  body?: unknown;
}

/**
 * EboekhoudenClient — owns the credentials map and the per-administration
 * session-token cache, and exposes a single `request()` method that all MCP
 * tools go through.
 */
export class EboekhoudenClient {
  private readonly defaultAdministration: string;
  private readonly credentialsMap: Map<string, AdministrationCredentials>;
  private readonly sessionCache = new Map<string, CachedSession>();

  constructor(defaultAdministration: string, credentialsMap?: Map<string, AdministrationCredentials>) {
    this.defaultAdministration = defaultAdministration;
    this.credentialsMap = credentialsMap ?? new Map();
  }

  // ── Introspection ──────────────────────────────────────────────────────────

  /** Default administration label from the environment. */
  get defaultAdministrationName(): string {
    return this.defaultAdministration;
  }

  /** Number of administrations with configured credentials. */
  get credentialsCount(): number {
    return this.credentialsMap.size;
  }

  /** List of all administration labels that currently have credentials. */
  listAdministrationNames(): string[] {
    return Array.from(this.credentialsMap.keys());
  }

  /** Lookup credentials for an administration, returning undefined when unknown. */
  getCredentials(administration: string): AdministrationCredentials | undefined {
    return this.credentialsMap.get(administration);
  }

  /** Resolve which administration to use for a call (falls back to the default). */
  private resolveAdministration(administration?: string): string {
    const name = administration ?? this.defaultAdministration;
    if (!name) {
      throw new Error(
        'No administration provided and EBOEKHOUDEN_ADMINISTRATION is not set. ' +
          'Pass `administration` explicitly or set a default in the environment.',
      );
    }
    return name;
  }

  // ── Credentials map reload ───────────────────────────────────────────────

  /**
   * Replace the in-memory `credentialsMap` with `next`, in place. Sessions for
   * administrations whose credentials **changed** or were **removed** are
   * evicted so the next call re-authenticates. Sessions for unchanged
   * administrations are kept warm. Returns a diff for the
   * `reload_credentials` MCP tool.
   */
  reloadCredentials(next: Map<string, AdministrationCredentials>): CredentialsReloadDiff {
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];

    for (const [name, previous] of this.credentialsMap) {
      const incoming = next.get(name);
      if (incoming === undefined) {
        removed.push(name);
        this.sessionCache.delete(name);
      } else if (incoming.apiToken !== previous.apiToken || incoming.source !== previous.source) {
        updated.push(name);
        this.sessionCache.delete(name);
      }
    }

    for (const name of next.keys()) {
      if (!this.credentialsMap.has(name)) added.push(name);
    }

    this.credentialsMap.clear();
    for (const [name, creds] of next) {
      this.credentialsMap.set(name, creds);
    }

    return { added, updated, removed, total: this.credentialsMap.size };
  }

  // ── Session flow ───────────────────────────────────────────────────────────

  /**
   * Return a valid (non-expired) session token for the given administration,
   * starting a new session via `POST /v1/session` when the cache is cold or
   * stale.
   */
  async getSessionToken(administration?: string): Promise<string> {
    const name = this.resolveAdministration(administration);
    const creds = this.credentialsMap.get(name);
    if (!creds) {
      throw new Error(
        `No e-Boekhouden credentials configured for administration "${name}". ` +
          'Add an entry to credentials.json or set EBOEKHOUDEN_API_TOKEN.',
      );
    }

    const cached = this.sessionCache.get(name);
    if (cached && cached.expiresAt > Date.now() + SESSION_RENEW_LEEWAY_MS) {
      return cached.token;
    }

    return this.startSession(name, creds);
  }

  /** Exchange the API token for a fresh session token and cache it. */
  private async startSession(administration: string, creds: AdministrationCredentials): Promise<string> {
    const source = creds.source ?? EBOEKHOUDEN_DEFAULT_SOURCE;
    if (!isValidSource(source)) {
      throw new Error(
        `Invalid \`source\` "${source}" for administration "${administration}". ` +
          'It must be 1–10 characters of [A-Za-z0-9_ ].',
      );
    }

    let data: SessionResponse;
    try {
      const response = await axios.post<SessionResponse>(
        `${EBOEKHOUDEN_BASE_URL}/${EBOEKHOUDEN_API_VERSION}/session`,
        { accessToken: creds.apiToken, source },
        { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: REQUEST_TIMEOUT_MS },
      );
      data = response.data;
    } catch (err) {
      throw translateApiError(err, `session start for administration "${administration}"`);
    }

    if (!data?.token) {
      throw new Error(`e-Boekhouden session endpoint returned no token for administration "${administration}".`);
    }

    const ttlSec = typeof data.expiresIn === 'number' && data.expiresIn > 0 ? data.expiresIn : DEFAULT_SESSION_TTL_SEC;
    this.sessionCache.set(administration, { token: data.token, expiresAt: Date.now() + ttlSec * 1000 });
    return data.token;
  }

  /**
   * Clear the cached session token(s).
   * - With an administration: only that entry is cleared.
   * - Without arguments: the entire session cache is cleared.
   */
  invalidateSession(administration?: string): void {
    if (administration) this.sessionCache.delete(administration);
    else this.sessionCache.clear();
  }

  // ── Core request ─────────────────────────────────────────────────────────

  /**
   * Execute an authenticated request against the e-Boekhouden REST API.
   * Acquires/renews the session token transparently and returns the parsed
   * JSON body (typed by the caller). On a 401 (expired/invalid session) the
   * session is evicted and the call is retried once.
   */
  async request<T = unknown>(options: RequestOptions): Promise<T> {
    const { administration, method = 'GET', path, query, body } = options;
    const name = this.resolveAdministration(administration);

    const send = async (): Promise<T> => {
      const token = await this.getSessionToken(name);
      const response = await axios.request<T>({
        method,
        url: `${EBOEKHOUDEN_BASE_URL}/${EBOEKHOUDEN_API_VERSION}${path}`,
        params: cleanQuery(query),
        data: body,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        timeout: REQUEST_TIMEOUT_MS,
      });
      return response.data;
    };

    try {
      return await send();
    } catch (err) {
      // A stale session yields 401; evict and retry once with a fresh session.
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        this.invalidateSession(name);
        try {
          return await send();
        } catch (retryErr) {
          throw translateApiError(retryErr, `${method} ${path}`);
        }
      }
      throw translateApiError(err, `${method} ${path}`);
    }
  }

  /**
   * Fetch every page of a list endpoint that uses `limit`/`offset` pagination,
   * returning the concatenated `items`. Stops when a page returns fewer than
   * `limit` items or when `maxItems` is reached.
   */
  async paginate<T = unknown>(
    path: string,
    options: { administration?: string; query?: Record<string, string | number | boolean | undefined>; limit?: number; maxItems?: number } = {},
  ): Promise<T[]> {
    const limit = options.limit ?? 100;
    const maxItems = options.maxItems ?? 1000;
    const all: T[] = [];
    let offset = 0;

    while (all.length < maxItems) {
      const page = await this.request<ListResponse<T>>({
        administration: options.administration,
        path,
        query: { ...options.query, limit, offset },
      });
      const items = page?.items ?? [];
      all.push(...items);
      if (items.length < limit) break;
      offset += limit;
    }

    return all.slice(0, maxItems);
  }
}

// ── Response shapes ─────────────────────────────────────────────────────────

interface SessionResponse {
  token: string;
  expiresIn?: number;
}

/** Generic list envelope: `{ items: [...], count: n }`. */
export interface ListResponse<T> {
  items?: T[];
  count?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Drop undefined/empty query values so axios doesn't emit `?x=`. */
function cleanQuery(
  query?: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> | undefined {
  if (!query) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === '') continue;
    out[k] = v;
  }
  return out;
}

/**
 * Translate axios/API errors into descriptive Error objects, surfacing the
 * e-Boekhouden error body (`{ code, message, ... }`) when present.
 */
function translateApiError(err: unknown, operation: string): Error {
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError;
    const data: unknown = ax.response?.data;
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      const code = obj['code'] ?? obj['errorCode'];
      const message = obj['message'] ?? obj['error'] ?? obj['title'];
      const tag = [code, message].filter(Boolean).join(': ');
      if (tag) {
        return new Error(`e-Boekhouden API error during ${operation} — ${tag} (HTTP ${ax.response?.status})`);
      }
    }
    if (ax.response) {
      const snippet =
        typeof data === 'string' && data.length > 0 ? ` — body: ${data.slice(0, 600)}` : '';
      return new Error(
        `e-Boekhouden API error during ${operation} — HTTP ${ax.response.status} ${ax.response.statusText}${snippet}`,
      );
    }
    return new Error(`e-Boekhouden network error during ${operation}: ${ax.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
