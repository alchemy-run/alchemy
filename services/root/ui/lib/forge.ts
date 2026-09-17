/**
 * The FORGE's client — typed fetchers over the embedded git server's
 * REST plane (`/api/v1`), the org's v3 issues facade (`/api/v3`),
 * and the app-plane write routes (`/api/forge`). Same-origin, like
 * every other app fetch.
 */

export interface SeedStatus {
  readonly repo: string;
  readonly status: string;
}

/** The org's repositories — the seed list IS the roster. */
export const fetchRepos = (): Promise<ReadonlyArray<SeedStatus>> =>
  fetch("/api/forge/seed")
    .then((response) => response.json() as Promise<{ seeds: SeedStatus[] }>)
    .then((body) => body.seeds);

export interface Ref {
  readonly name: string;
  readonly oid: string;
}

export const fetchBranches = (
  repo: string,
): Promise<{ head: string | null; refs: ReadonlyArray<Ref> }> =>
  fetch(
    `/api/v1/repos/org/${encodeURIComponent(repo)}/refs?prefix=${encodeURIComponent("refs/heads/")}`,
  ).then(
    (response) =>
      response.json() as Promise<{
        head: string | null;
        refs: ReadonlyArray<Ref>;
      }>,
  );

export interface CommitInfo {
  readonly oid: string;
  readonly tree: string;
  readonly parents: ReadonlyArray<string>;
  readonly author?: { name?: string; email?: string; date?: number };
  readonly message?: string;
}

export const fetchLog = (
  repo: string,
  ref: string,
  limit = 20,
): Promise<ReadonlyArray<CommitInfo>> =>
  fetch(
    `/api/v1/repos/org/${encodeURIComponent(repo)}/log?ref=${encodeURIComponent(ref)}&limit=${limit}`,
  )
    .then(
      (response) => response.json() as Promise<{ items: CommitInfo[] }>,
    )
    .then((body) => body.items ?? []);

export interface TreeEntry {
  readonly name: string;
  readonly oid: string;
  readonly mode?: string | number;
  readonly type?: string;
}

/** A directory entry is a tree — by declared type or git mode 040000. */
export const isDirectory = (entry: TreeEntry): boolean =>
  entry.type === "tree" || String(entry.mode ?? "").startsWith("40") ||
  String(entry.mode ?? "").startsWith("040");

export const fetchTree = (
  repo: string,
  oid: string,
): Promise<ReadonlyArray<TreeEntry>> =>
  fetch(`/api/v1/repos/org/${encodeURIComponent(repo)}/trees/${oid}`)
    .then(
      (response) => response.json() as Promise<{ entries: TreeEntry[] }>,
    )
    .then((body) => body.entries ?? []);

/** A file's text at `ref` + `path` (the server walks the trees). */
export const fetchFile = (
  repo: string,
  ref: string,
  path: string,
): Promise<{ ok: boolean; text: string }> =>
  fetch(
    `/api/v1/repos/org/${encodeURIComponent(repo)}/file?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
  ).then(async (response) => ({
    ok: response.ok,
    text: await response.text(),
  }));

/* ── issues + pulls (the v3 facade + app-plane writes) ────────────── */

export interface ForgeIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: "open" | "closed";
  readonly user: { login: string };
  readonly labels: ReadonlyArray<{ name: string }>;
  readonly comments: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
  readonly pull_request?: {
    merged_at: string | null;
    head_ref: string | null;
    base_ref: string | null;
  };
  readonly draft?: boolean;
}

export interface ForgeComment {
  readonly id: number;
  readonly body: string;
  readonly user: { login: string };
  readonly created_at: string;
}

export const fetchIssues = (
  repo: string,
  kind: "issue" | "pull",
  state: "open" | "closed" | "all",
  page = 1,
): Promise<ReadonlyArray<ForgeIssue>> =>
  fetch(
    `/api/v3/repos/org/${encodeURIComponent(repo)}/issues?kind=${kind}&state=${state}&page=${page}&per_page=50`,
  ).then((response) => response.json() as Promise<ForgeIssue[]>);

export const fetchIssue = (
  repo: string,
  number: number,
): Promise<ForgeIssue | undefined> =>
  fetch(`/api/v3/repos/org/${encodeURIComponent(repo)}/issues/${number}`).then(
    (response) =>
      response.ok
        ? (response.json() as Promise<ForgeIssue>)
        : Promise.resolve(undefined),
  );

export const fetchComments = (
  repo: string,
  number: number,
): Promise<ReadonlyArray<ForgeComment>> =>
  fetch(
    `/api/v3/repos/org/${encodeURIComponent(repo)}/issues/${number}/comments`,
  ).then((response) => response.json() as Promise<ForgeComment[]>);

/** App-plane writes — the human's door, no forge credential. */
export const createIssue = (
  repo: string,
  input: { title: string; body?: string },
): Promise<ForgeIssue> =>
  fetch(`/api/forge/repos/org/${encodeURIComponent(repo)}/issues`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }).then((response) => response.json() as Promise<ForgeIssue>);

export const addIssueComment = (
  repo: string,
  number: number,
  body: string,
): Promise<ForgeComment> =>
  fetch(
    `/api/forge/repos/org/${encodeURIComponent(repo)}/issues/${number}/comments`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    },
  ).then((response) => response.json() as Promise<ForgeComment>);

/** One GitHub-shaped timeline event (`committed`, `reviewed`,
 *  `commented`, `merged`, `closed`, `labeled`, …) — the renderer
 *  keys on `event` and ignores kinds it doesn't know. */
export interface TimelineEvent {
  readonly event: string;
  readonly [key: string]: unknown;
}

export const fetchTimeline = (
  repo: string,
  number: number,
): Promise<ReadonlyArray<TimelineEvent>> =>
  fetch(
    `/api/forge/repos/org/${encodeURIComponent(repo)}/issues/${number}/timeline`,
  ).then((response) =>
    response.ok
      ? (response.json() as Promise<TimelineEvent[]>)
      : Promise.resolve([]),
  );

/** A pull's unified diff (text) — 501 when no source serves it yet. */
export const fetchPullDiff = (
  repo: string,
  number: number,
): Promise<{ ok: boolean; text: string }> =>
  fetch(
    `/api/forge/repos/org/${encodeURIComponent(repo)}/pulls/${number}/diff`,
  ).then(async (response) => ({
    ok: response.ok,
    text: await response.text(),
  }));

export const patchIssue = (
  repo: string,
  number: number,
  patch: { state?: "open" | "closed"; title?: string; body?: string },
): Promise<ForgeIssue> =>
  fetch(`/api/forge/repos/org/${encodeURIComponent(repo)}/issues/${number}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).then((response) => response.json() as Promise<ForgeIssue>);
