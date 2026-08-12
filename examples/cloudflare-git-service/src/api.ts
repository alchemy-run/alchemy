/**
 * Plain-fetch client of the git-service REST API (`/api/v1`).
 *
 * The types mirror `@alchemy.run/git`'s API schemas (`src/api/Schema.ts`)
 * by hand — the SPA deliberately ships no Effect runtime; it is an example
 * of consuming the service from any plain JS frontend.
 */

// ── configuration ───────────────────────────────────────────────────────────

const URL_KEY = "git-service:url";
const TOKEN_KEY = "git-service:token";

/** Base URL baked in at deploy (`env.VITE_GIT_URL` on Website.Vite). */
const builtinUrl: string | undefined = import.meta.env.VITE_GIT_URL;

export interface Connection {
  readonly url: string;
  /** Absent = anonymous: public repos are readable without any token. */
  readonly token?: string | undefined;
}

export const getConnection = (): Connection | null => {
  const url = localStorage.getItem(URL_KEY) ?? builtinUrl;
  if (!url) return null;
  const token = localStorage.getItem(TOKEN_KEY);
  return { url: url.replace(/\/+$/, ""), token: token ?? undefined };
};

export const defaultUrl = (): string =>
  localStorage.getItem(URL_KEY) ?? builtinUrl ?? "";

export const saveConnection = (url: string, token?: string): void => {
  localStorage.setItem(URL_KEY, url.replace(/\/+$/, ""));
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
};

export const signOut = (): void => {
  localStorage.removeItem(TOKEN_KEY);
};

// ── API types (mirroring src/api/Schema.ts) ─────────────────────────────────

export type TokenScope = "read" | "write" | "admin";
export type RepoStatus = "ready" | "importing" | "forking" | "deleting";

export interface ObjectStats {
  loose: number;
  packed: number;
  r2: number;
  bytes: number;
}

export interface PushStats {
  objects: number;
  bytes: number;
  ingestMs: number;
  stageMs: number;
  connectivityMs: number;
  finalizeMs: number;
  totalMs: number;
}

export interface Repo {
  owner: string;
  name: string;
  repoId: string;
  defaultBranch: string;
  description: string | null;
  readOnly: boolean;
  /** Readable (REST + clone) without a token. */
  public: boolean;
  forkOf: string | null;
  status: RepoStatus;
  createdAt: number;
  objects: ObjectStats;
  lastPush: PushStats | null;
}

export interface Ref {
  name: string;
  oid: string;
  peeled?: string;
}

export interface Signature {
  name: string;
  email: string;
  /** Unix timestamp (seconds). */
  date: number;
  /** Timezone offset as written, e.g. `+0200`. */
  tz: string;
}

export interface CommitInfo {
  oid: string;
  tree: string;
  parents: string[];
  author: Signature;
  committer: Signature;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
  type: "blob" | "tree" | "commit";
}

export interface TokenInfo {
  id: string;
  name: string;
  scope: TokenScope;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
}

export interface CreatedToken extends TokenInfo {
  token: string;
}

export interface RepoCreated {
  repo: Repo;
  remote: string;
  token: CreatedToken;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

// ── errors ──────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly tag: string,
    override readonly message: string,
  ) {
    super(message);
  }
}

const parseError = async (res: Response): Promise<ApiError> => {
  let tag = `HTTP ${res.status}`;
  let message = res.statusText;
  try {
    const body: unknown = await res.clone().json();
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      if (typeof record._tag === "string") tag = record._tag;
      if (typeof record.message === "string") message = record.message;
      else if (typeof record.reason === "string") message = record.reason;
    }
  } catch {
    try {
      message = (await res.text()) || message;
    } catch {
      /* keep statusText */
    }
  }
  return new ApiError(res.status, tag, message || tag);
};

// ── transport ───────────────────────────────────────────────────────────────

const request = async <T>(
  connection: Connection,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> => {
  const res = await fetch(`${connection.url}/api/v1${path}`, {
    method,
    headers: {
      // Anonymous requests carry no Authorization header at all — the
      // service grants read on public repos to tokenless callers.
      ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text.length === 0 ? undefined : JSON.parse(text)) as T;
};

const seg = encodeURIComponent;

// ── repos ───────────────────────────────────────────────────────────────────

export const listRepos = (
  c: Connection,
  query?: { owner?: string; cursor?: string; limit?: number },
): Promise<Page<Repo>> => {
  const params = new URLSearchParams();
  if (query?.owner) params.set("owner", query.owner);
  if (query?.cursor) params.set("cursor", query.cursor);
  if (query?.limit) params.set("limit", String(query.limit));
  const qs = params.size > 0 ? `?${params}` : "";
  return request(c, "GET", `/repos${qs}`);
};

export const getRepo = (c: Connection, owner: string, repo: string) =>
  request<Repo>(c, "GET", `/repos/${seg(owner)}/${seg(repo)}`);

export const createRepo = (
  c: Connection,
  payload: {
    owner: string;
    name: string;
    description?: string;
    public?: boolean;
  },
) => request<RepoCreated>(c, "POST", `/repos`, payload);

export const updateRepo = (
  c: Connection,
  owner: string,
  repo: string,
  payload: {
    description?: string | null;
    defaultBranch?: string;
    readOnly?: boolean;
    public?: boolean;
  },
) => request<Repo>(c, "PATCH", `/repos/${seg(owner)}/${seg(repo)}`, payload);

export const deleteRepo = (c: Connection, owner: string, repo: string) =>
  request<unknown>(c, "DELETE", `/repos/${seg(owner)}/${seg(repo)}`);

export const compactRepo = (c: Connection, owner: string, repo: string) =>
  request<unknown>(c, "POST", `/repos/${seg(owner)}/${seg(repo)}/compact`);

// ── refs ────────────────────────────────────────────────────────────────────

export const listRefs = (c: Connection, owner: string, repo: string) =>
  request<{ head: string | null; refs: Ref[] }>(
    c,
    "GET",
    `/repos/${seg(owner)}/${seg(repo)}/refs`,
  );

// ── objects ─────────────────────────────────────────────────────────────────

export const getCommit = (
  c: Connection,
  owner: string,
  repo: string,
  oid: string,
) =>
  request<CommitInfo>(
    c,
    "GET",
    `/repos/${seg(owner)}/${seg(repo)}/commits/${seg(oid)}`,
  );

export const getLog = (
  c: Connection,
  owner: string,
  repo: string,
  query?: { ref?: string; cursor?: string; limit?: number },
): Promise<Page<CommitInfo>> => {
  const params = new URLSearchParams();
  if (query?.ref) params.set("ref", query.ref);
  if (query?.cursor) params.set("cursor", query.cursor);
  if (query?.limit) params.set("limit", String(query.limit));
  const qs = params.size > 0 ? `?${params}` : "";
  return request(c, "GET", `/repos/${seg(owner)}/${seg(repo)}/log${qs}`);
};

export const getTree = (
  c: Connection,
  owner: string,
  repo: string,
  oid: string,
) =>
  request<{ oid: string; entries: TreeEntry[] }>(
    c,
    "GET",
    `/repos/${seg(owner)}/${seg(repo)}/trees/${seg(oid)}`,
  );

/** Raw file bytes at `ref` + `path` (the streaming non-JSON route). */
export const getFile = async (
  c: Connection,
  owner: string,
  repo: string,
  options: { ref?: string; path: string },
): Promise<Uint8Array> => {
  const params = new URLSearchParams({ path: options.path });
  if (options.ref) params.set("ref", options.ref);
  const res = await fetch(
    `${c.url}/api/v1/repos/${seg(owner)}/${seg(repo)}/file?${params}`,
    {
      headers: c.token ? { Authorization: `Bearer ${c.token}` } : {},
    },
  );
  if (!res.ok) throw await parseError(res);
  return new Uint8Array(await res.arrayBuffer());
};

// ── tokens ──────────────────────────────────────────────────────────────────

export const listTokens = (c: Connection, owner: string, repo: string) =>
  request<TokenInfo[]>(c, "GET", `/repos/${seg(owner)}/${seg(repo)}/tokens`);

export const createToken = (
  c: Connection,
  owner: string,
  repo: string,
  payload: { name: string; scope: TokenScope; ttlSeconds?: number },
) =>
  request<CreatedToken>(
    c,
    "POST",
    `/repos/${seg(owner)}/${seg(repo)}/tokens`,
    payload,
  );

export const revokeToken = (
  c: Connection,
  owner: string,
  repo: string,
  id: string,
) =>
  request<unknown>(
    c,
    "DELETE",
    `/repos/${seg(owner)}/${seg(repo)}/tokens/${seg(id)}`,
  );
