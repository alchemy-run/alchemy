/**
 * GitHub access for a container through its Durable Object's egress: `gh`
 * and `git` in the container work with a placeholder token, while the Durable
 * Object checks each request against the declared repositories and
 * permissions, adds the real token, and forwards it.
 */
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import {
  type Egress as ContainerEgress,
  Egress as makeContainerEgress,
  egressSecret,
  type EgressSecret,
  makeEgressHandle,
  refuse,
} from "../Cloudflare/Containers/Egress.ts";
import { gitCliLayer } from "../FS/GitMount.ts";
import * as Output from "../Output.ts";
import { GitHubCredentials } from "./Credentials.ts";
import { ghCliLayer } from "./MountRepository.ts";
import type { Repository } from "./Repository.ts";

//#region options

export type GitHubPermissionLevel = "read" | "write";

/** What the container may do in one repository. Anything not granted is refused. */
export interface RepositoryAccess {
  /** A repository this stack declares, or `owner/name`. */
  readonly repository: Repository | Effect.Effect<Repository, never, any> | `${string}/${string}`;
  /** Code: files, commits, branches, tags, releases; `git` fetch (read) and push (write). */
  readonly contents?: GitHubPermissionLevel;
  /** Pull requests, their reviews and review comments. */
  readonly pullRequests?: GitHubPermissionLevel;
  /** Issues, labels, milestones, and comments on issues and pull requests. */
  readonly issues?: GitHubPermissionLevel;
  /** GitHub Actions workflow runs and logs. */
  readonly actions?: GitHubPermissionLevel;
  /** Check runs and suites. */
  readonly checks?: GitHubPermissionLevel;
  /** Commit statuses. */
  readonly statuses?: GitHubPermissionLevel;
  /** Branches `git push` may update (globs: `agent/**`). @default every branch, with contents: write */
  readonly push?: { readonly branches: ReadonlyArray<string> };
}

export interface EgressOptions {
  /**
   * The token added to requests: a PAT, `GitHub.ProfileToken` (the stack's
   * GitHub auth profile), or a `Config`. Bound into the Worker; the container
   * only sees a placeholder.
   */
  readonly token: EgressSecret;
  /** The repositories the container may reach, and how. */
  readonly repositories: ReadonlyArray<RepositoryAccess>;
}

/** Narrow a GitHub egress to one pull request or issue. */
export type Scope =
  | { readonly repository: string; readonly pullRequest: number }
  | { readonly repository: string; readonly issue: number };

/** A GitHub egress, which can be narrowed to one pull request or issue. */
export interface Egress extends ContainerEgress {
  /**
   * The same access, narrowed: writes only to `pullRequest` (and its head
   * branch) or `issue` (and branches `agent/issue-<n>/**`). It can only
   * shrink what was declared.
   */
  readonly narrow: (scope: Scope) => ContainerEgress;
}

//#endregion

/**
 * The token of the stack's GitHub auth profile (`gh auth token`, a stored
 * PAT, or `GITHUB_TOKEN`), resolved at deploy and bound into the Worker as a
 * secret. Pass it explicitly: it acts as you, with everything you can reach.
 */
export const ProfileToken: Output.Output<
  Redacted.Redacted<string>,
  GitHubCredentials
> = Output.fromEffect(
  Effect.gen(function* () {
    const credentials = yield* yield* GitHubCredentials;
    return credentials.token;
  }).pipe(Effect.orDie),
) as Output.Output<Redacted.Redacted<string>, GitHubCredentials>;

/** What the container sees instead of the token. */
const PLACEHOLDER = "alchemy-egress";

const API_HOSTS = ["api.github.com", "uploads.github.com"];
const GIT_HOST = "github.com";

//#region classification

type Permission = "contents" | "pullRequests" | "issues" | "actions" | "checks" | "statuses";

/** One intercepted request, as the policy sees it. */
type Classified =
  | {
      readonly kind: "repo";
      readonly repository: string;
      readonly permission: Permission | "metadata";
      readonly write: boolean;
      /** The pull request or issue number the request touches, when it names one. */
      readonly number?: number;
      /** Creates a new pull request or issue. */
      readonly creates?: "pullRequest" | "issue";
      /** Branches a `git push` updates. */
      readonly refs?: ReadonlyArray<string>;
    }
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string };

const REST_PERMISSION: Record<string, Permission | "metadata"> = {
  contents: "contents",
  git: "contents",
  commits: "contents",
  branches: "contents",
  compare: "contents",
  tags: "contents",
  releases: "contents",
  readme: "contents",
  zipball: "contents",
  tarball: "contents",
  merges: "contents",
  pulls: "pullRequests",
  issues: "issues",
  labels: "issues",
  milestones: "issues",
  assignees: "issues",
  actions: "actions",
  "check-runs": "checks",
  "check-suites": "checks",
  statuses: "statuses",
  languages: "metadata",
  topics: "metadata",
  contributors: "metadata",
  collaborators: "metadata",
};

/** Account-level endpoints `gh` reads (who am I, rate limits). */
const ACCOUNT_READS = [/^\/user$/, /^\/rate_limit$/, /^\/meta$/, /^\/octocat$/, /^\/zen$/];

const classifyRest = (method: string, pathname: string): Classified => {
  const write = !(method === "GET" || method === "HEAD");
  const repo = /^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(pathname);
  if (!repo) {
    if (!write && ACCOUNT_READS.some((pattern) => pattern.test(pathname))) {
      return { kind: "allow" };
    }
    return { kind: "deny", reason: `${method} ${pathname} is not an allowed GitHub API endpoint` };
  }
  const repository = `${repo[1]}/${repo[2]}`.toLowerCase();
  const rest = (repo[3] ?? "").split("/").filter(Boolean);
  if (rest.length === 0) {
    return write
      ? { kind: "deny", reason: `changing ${repository}'s settings is not allowed` }
      : { kind: "repo", repository, permission: "metadata", write: false };
  }
  // `commits/{sha}/status(es)` are commit statuses, not contents.
  const permission =
    rest[0] === "commits" && (rest[2] === "status" || rest[2] === "statuses")
      ? "statuses"
      : REST_PERMISSION[rest[0]!];
  if (permission === undefined) {
    return {
      kind: "deny",
      reason: `${method} ${pathname} is not an allowed GitHub API endpoint`,
    };
  }
  const number =
    (rest[0] === "pulls" || rest[0] === "issues") && /^\d+$/.test(rest[1] ?? "")
      ? Number(rest[1])
      : undefined;
  const creates =
    method === "POST" && rest.length === 1 && rest[0] === "pulls"
      ? ("pullRequest" as const)
      : method === "POST" && rest.length === 1 && rest[0] === "issues"
        ? ("issue" as const)
        : undefined;
  return {
    kind: "repo",
    repository,
    permission,
    write,
    ...(number !== undefined ? { number } : {}),
    ...(creates ? { creates } : {}),
  };
};

/** GraphQL mutations `gh` sends, and the permission each needs. */
const MUTATION_PERMISSION: Record<string, Permission> = {
  createPullRequest: "pullRequests",
  updatePullRequest: "pullRequests",
  closePullRequest: "pullRequests",
  reopenPullRequest: "pullRequests",
  mergePullRequest: "pullRequests",
  markPullRequestReadyForReview: "pullRequests",
  convertPullRequestToDraft: "pullRequests",
  addPullRequestReview: "pullRequests",
  submitPullRequestReview: "pullRequests",
  addPullRequestReviewComment: "pullRequests",
  addPullRequestReviewThread: "pullRequests",
  requestReviews: "pullRequests",
  updatePullRequestBranch: "pullRequests",
  enablePullRequestAutoMerge: "pullRequests",
  disablePullRequestAutoMerge: "pullRequests",
  createIssue: "issues",
  updateIssue: "issues",
  closeIssue: "issues",
  reopenIssue: "issues",
  addComment: "issues",
  updateIssueComment: "issues",
  deleteIssueComment: "issues",
  addLabelsToLabelable: "issues",
  removeLabelsFromLabelable: "issues",
  addAssigneesToAssignable: "issues",
  removeAssigneesFromAssignable: "issues",
  addReaction: "issues",
  removeReaction: "issues",
  createRef: "contents",
  updateRef: "contents",
  deleteRef: "contents",
  createCommitOnBranch: "contents",
};

/** Input fields that carry the node id of what a mutation acts on. */
const NODE_ID_FIELDS = [
  "repositoryId",
  "pullRequestId",
  "issueId",
  "subjectId",
  "labelableId",
  "assignableId",
  "id",
];

/** `{ pullRequest | issue, repository }` of a GraphQL node, resolved through the API. */
interface ResolvedNode {
  readonly repository: string;
  readonly number?: number;
}

/** The (first) mutation field a GraphQL document calls. */
const mutationName = (query: string) => /^\s*mutation\b[^{]*\{\s*(\w+)/.exec(query)?.[1];

/** `repository(owner: ..., name: ...)` in a query: literals or variables. */
const queryRepository = (query: string, variables: Record<string, unknown>) => {
  const match = /repository\s*\(\s*([^)]*)\)/.exec(query);
  if (!match) return undefined;
  const arg = (name: string) => {
    const value = new RegExp(`${name}\\s*:\\s*("([^"]*)"|\\$(\\w+))`).exec(match[1]!);
    if (!value) return undefined;
    return value[2] ?? (value[3] ? String(variables[value[3]] ?? "") : undefined);
  };
  const owner = arg("owner");
  const name = arg("name");
  return owner && name ? `${owner}/${name}`.toLowerCase() : undefined;
};

//#endregion

const glob = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split("**")
      .map((part) =>
        part
          .split("*")
          .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*"),
      )
      .join(".*")}$`,
  );

/** Ref names a `git push` (receive-pack request) updates. */
const pushedRefs = (body: Uint8Array) => {
  const refs: string[] = [];
  let offset = 0;
  const text = new TextDecoder();
  while (offset + 4 <= body.length) {
    const length = parseInt(text.decode(body.subarray(offset, offset + 4)), 16);
    if (Number.isNaN(length) || length === 0) break;
    const line = text.decode(body.subarray(offset + 4, offset + length)).split("\0")[0]!;
    const ref = line.trim().split(" ")[2];
    if (ref) refs.push(ref);
    offset += length;
  }
  return refs;
};

/** A pkt-line: 4 hex digits of length (including themselves), then the payload. */
const pktLine = (payload: Uint8Array | string) => {
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const out = new Uint8Array(bytes.length + 4);
  out.set(new TextEncoder().encode((bytes.length + 4).toString(16).padStart(4, "0")));
  out.set(bytes, 4);
  return out;
};

const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/**
 * Refuse a `git push` the way a git server does: a report-status that marks
 * each ref rejected, so git prints `! [remote rejected] … (reason)`.
 */
const rejectPush = (refs: ReadonlyArray<string>, reason: string, sideband: boolean) => {
  const report = concat([
    pktLine("unpack ok\n"),
    ...refs.map((ref) => pktLine(`ng ${ref} ${reason.replace(/\n/g, " ")}\n`)),
    new TextEncoder().encode("0000"),
  ]);
  const body = sideband
    ? concat([pktLine(concat([Uint8Array.of(1), report])), new TextEncoder().encode("0000")])
    : report;
  return HttpServerResponse.uint8Array(body, {
    status: 200,
    contentType: "application/x-git-receive-pack-result",
  });
};

const bodyBytes = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const body = request.body;
    if (body._tag !== "Uint8Array") return new Uint8Array();
    if (request.headers["content-encoding"] !== "gzip") return body.body;
    return yield* Effect.promise(async () => {
      const stream = new Response(body.body as BufferSource).body!.pipeThrough(
        new DecompressionStream("gzip"),
      );
      return new Uint8Array(await new Response(stream).arrayBuffer());
    });
  });

/**
 * GitHub access for a container, without the token ever entering it: `gh`
 * and `git` (over HTTPS) work in the container with a placeholder, and the
 * Durable Object that owns the container checks each request against
 * `repositories` (deny by default), adds the real token, and forwards it.
 * Declare it at the top of that Durable Object; pass it, or a narrowed copy,
 * to the container's `start({ egress })`.
 *
 * ### Giving an agent `gh` and `git`
 * **Example:** Pushes only to agent branches, using your GitHub login
 * ```typescript
 * export class Agent extends Cloudflare.DurableObject<Agent>()(
 *   "Agent",
 *   Effect.gen(function* () {
 *     const github = yield* GitHub.Egress(Sandbox, {
 *       token: GitHub.ProfileToken,
 *       repositories: [
 *         {
 *           repository: "alchemy-run/alchemy",
 *           contents: "write",
 *           pullRequests: "write",
 *           issues: "read",
 *           push: { branches: ["agent/**"] },
 *         },
 *       ],
 *     });
 *     const harness = yield* Cloudflare.Containers.Harness(Sandbox);
 *     return Effect.gen(function* () {
 *       return {
 *         // Writes only to pull request #n and its branch.
 *         open: (pullRequest: number) =>
 *           harness
 *             .start({
 *               egress: [github.narrow({ repository: "alchemy-run/alchemy", pullRequest })],
 *             })
 *             .pipe(Effect.flatMap((claude) => claude.start({}))),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @binding
 * @product Egress
 * @category GitHub
 */
export const Egress = (container: unknown, options: EgressOptions) =>
  Effect.gen(function* () {
    const token = yield* egressSecret(options.token, "ALCHEMY_GITHUB_EGRESS_TOKEN");

    // Each repository's `owner/name`, read at runtime (a declared repository's
    // name is an Output of its resource).
    const repositories = yield* Effect.forEach(options.repositories, (access, i) =>
      Effect.gen(function* () {
        if (typeof access.repository === "string") {
          return { access, name: Effect.succeed(access.repository.toLowerCase()) };
        }
        // A declaration resolves while planning, where the stack provides it.
        const resource = Effect.isEffect(access.repository)
          ? yield* access.repository as Effect.Effect<Repository>
          : access.repository;
        const fullName = yield* Output.named(
          resource.fullName as unknown as Output.Output<string>,
          `ALCHEMY_GITHUB_EGRESS_REPO_${i}`,
        ).asEffect() as unknown as Effect.Effect<Effect.Effect<string>>;
        return { access, name: Effect.map(fullName, (n) => n.toLowerCase()) };
      }),
    );
    const policy = Effect.map(
      Effect.forEach(repositories, ({ access, name }) =>
        Effect.map(name, (n) => [n, access] as const),
      ),
      (entries) => new Map(entries),
    );

    const github = (path: string, body?: unknown) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const key = Redacted.value(yield* token);
        const request = (
          body === undefined
            ? HttpClientRequest.get(`https://api.github.com${path}`)
            : HttpClientRequest.post(`https://api.github.com${path}`).pipe(
                HttpClientRequest.bodyJsonUnsafe(body),
              )
        ).pipe(
          HttpClientRequest.setHeader("authorization", `token ${key}`),
          HttpClientRequest.setHeader("user-agent", "alchemy-egress"),
        );
        const response = yield* client.execute(request);
        return (yield* response.json) as any;
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.orElseSucceed(() => undefined),
      );

    // GraphQL node id → repository (and number), cached for this object's life.
    const nodes = new Map<string, ResolvedNode | undefined>();
    const resolveNode = (id: string) =>
      Effect.gen(function* () {
        if (nodes.has(id)) return nodes.get(id);
        const result = yield* github("/graphql", {
          query:
            "query($id: ID!) { node(id: $id) { ... on Repository { nameWithOwner } ... on PullRequest { number repository { nameWithOwner } } ... on Issue { number repository { nameWithOwner } } ... on IssueComment { issue { number } repository { nameWithOwner } } ... on PullRequestReview { pullRequest { number } repository { nameWithOwner } } } }",
          variables: { id },
        });
        const node = result?.data?.node;
        const resolved: ResolvedNode | undefined = node
          ? {
              repository: String(
                node.nameWithOwner ?? node.repository?.nameWithOwner ?? "",
              ).toLowerCase(),
              ...((node.number ?? node.issue?.number ?? node.pullRequest?.number)
                ? { number: Number(node.number ?? node.issue?.number ?? node.pullRequest?.number) }
                : {}),
            }
          : undefined;
        nodes.set(id, resolved);
        return resolved;
      });

    /** What a request is, in policy terms. */
    const classify = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* (): Effect.fn.Return<Classified> {
        const url = new URL(request.url);
        if (url.hostname === GIT_HOST) {
          const repo =
            /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
              url.pathname,
            );
          if (!repo)
            return { kind: "deny", reason: `github.com${url.pathname} is not a git endpoint` };
          const repository = `${repo[1]}/${repo[2]}`.toLowerCase();
          const service = repo[3] === "info/refs" ? url.searchParams.get("service") : repo[3];
          if (service === "git-receive-pack" && repo[3] === "git-receive-pack") {
            return {
              kind: "repo",
              repository,
              permission: "contents",
              write: true,
              refs: pushedRefs(yield* bodyBytes(request)),
            };
          }
          return {
            kind: "repo",
            repository,
            permission: "contents",
            write: service === "git-receive-pack",
          };
        }
        if (url.pathname === "/graphql") {
          const text = new TextDecoder().decode(yield* bodyBytes(request));
          const document = (() => {
            try {
              return JSON.parse(text) as { query?: string; variables?: Record<string, unknown> };
            } catch {
              return undefined;
            }
          })();
          const query = document?.query ?? "";
          const variables = document?.variables ?? {};
          const mutation = mutationName(query);
          if (mutation === undefined) {
            const repository = queryRepository(query, variables);
            return repository
              ? { kind: "repo", repository, permission: "metadata", write: false }
              : { kind: "allow" };
          }
          const permission = MUTATION_PERMISSION[mutation];
          if (permission === undefined) {
            return { kind: "deny", reason: `the GraphQL mutation ${mutation} is not allowed` };
          }
          const input = (variables.input ?? variables) as Record<string, unknown>;
          const id = NODE_ID_FIELDS.map((field) => input[field]).find((v) => typeof v === "string");
          const node = typeof id === "string" ? yield* resolveNode(id) : undefined;
          if (!node?.repository) {
            return { kind: "deny", reason: `can't tell which repository ${mutation} changes` };
          }
          return {
            kind: "repo",
            repository: node.repository,
            permission,
            write: true,
            ...(node.number !== undefined ? { number: node.number } : {}),
            ...(mutation === "createPullRequest"
              ? { creates: "pullRequest" as const }
              : mutation === "createIssue"
                ? { creates: "issue" as const }
                : {}),
          };
        }
        return classifyRest(request.method, url.pathname);
      });

    const LEVEL = { read: 1, write: 2 } as const;

    /** Allowed, or why not — against the declared access (and an optional scope). */
    const authorize = (classified: Classified, scope: (Scope & { branch: string }) | undefined) =>
      Effect.gen(function* () {
        if (classified.kind === "allow") return undefined;
        if (classified.kind === "deny") return classified.reason;
        const access = (yield* policy).get(classified.repository);
        if (!access) return `${classified.repository} is not an allowed repository`;
        if (scope && scope.repository.toLowerCase() !== classified.repository) {
          return `this session works on ${scope.repository} only`;
        }
        if (classified.permission !== "metadata") {
          const granted = access[classified.permission];
          const needed = classified.write ? "write" : "read";
          if (!granted || LEVEL[granted] < LEVEL[needed]) {
            return `${classified.permission}:${needed} is not granted on ${classified.repository}${granted ? ` (granted: ${granted})` : ""}`;
          }
        }
        if (classified.refs) {
          const allowed = (scope ? [scope.branch] : (access.push?.branches ?? ["**"])).map(glob);
          const blocked = classified.refs.find(
            (ref) => !allowed.some((pattern) => pattern.test(ref.replace(/^refs\/heads\//, ""))),
          );
          if (blocked) {
            return `push to ${blocked} is not allowed (allowed: ${(scope ? [scope.branch] : (access.push?.branches ?? [])).join(", ")})`;
          }
        }
        if (scope && classified.write) {
          const target = "pullRequest" in scope ? scope.pullRequest : scope.issue;
          if (classified.creates === "issue" || ("pullRequest" in scope && classified.creates)) {
            return `this session works on #${target} only`;
          }
          if (classified.number !== undefined && classified.number !== target) {
            return `this session works on #${target} only, not #${classified.number}`;
          }
        }
        return undefined;
      });

    /**
     * Refuse in the form the client shows: a GitHub API error for `gh`, a
     * rejected ref for `git push`, plain text otherwise.
     */
    const refusal = (
      request: HttpClientRequest.HttpClientRequest,
      classified: Classified,
      reason: string,
    ) =>
      Effect.gen(function* () {
        const message = `alchemy egress: ${reason}`;
        const url = new URL(request.url);
        if (classified.kind === "repo" && classified.refs && classified.refs.length > 0) {
          const first = new TextDecoder().decode(yield* bodyBytes(request)).split("\0")[1] ?? "";
          return rejectPush(classified.refs, message, /side-band(-64k)?/.test(first));
        }
        if (API_HOSTS.includes(url.hostname)) {
          return yield* HttpServerResponse.json(
            { message, documentation_url: "https://alchemy.run" },
            { status: 403 },
          ).pipe(Effect.orDie);
        }
        return refuse(reason);
      });

    /** Add the real token for the host the request goes to. */
    const authenticate = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.map(token, (key) => {
        const url = new URL(request.url);
        const value =
          url.hostname === GIT_HOST
            ? `Basic ${btoa(`x-access-token:${Redacted.value(key)}`)}`
            : `token ${Redacted.value(key)}`;
        return HttpClientRequest.setHeader(request, "authorization", value);
      });

    const handlerFor =
      (scope: (Scope & { branch: string }) | undefined) =>
      (request: HttpClientRequest.HttpClientRequest) =>
        Effect.gen(function* () {
          const classified = yield* classify(request);
          const reason = yield* authorize(classified, scope);
          if (reason !== undefined) return yield* refusal(request, classified, reason);
          return yield* authenticate(request);
        });

    const containerSide = {
      env: { GH_TOKEN: PLACEHOLDER, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
      image: [gitCliLayer, ghCliLayer],
    };

    const egress = yield* makeContainerEgress(
      container,
      [...API_HOSTS, GIT_HOST],
      handlerFor(undefined),
      { key: "github", ...containerSide },
    );

    /** The branch a scope may push to (a pull request's head, looked up once). */
    const branches = new Map<string, string>();
    const branchFor = (scope: Scope) =>
      Effect.gen(function* () {
        if ("issue" in scope) return `agent/issue-${scope.issue}/**`;
        const key = `${scope.repository}#${scope.pullRequest}`;
        const cached = branches.get(key);
        if (cached) return cached;
        const pull = yield* github(`/repos/${scope.repository}/pulls/${scope.pullRequest}`);
        const branch =
          pull?.head?.repo?.full_name?.toLowerCase() === scope.repository.toLowerCase()
            ? String(pull.head.ref)
            : // A fork's head isn't pushable with this token: no branch.
              "\0";
        branches.set(key, branch);
        return branch;
      });

    return {
      ...egress,
      narrow: (scope: Scope): ContainerEgress => {
        const target = "pullRequest" in scope ? `pr${scope.pullRequest}` : `issue${scope.issue}`;
        return {
          ...egress,
          key: `github:${scope.repository.toLowerCase()}#${target}`,
          handle: (request) =>
            Effect.flatMap(branchFor(scope), (branch) =>
              makeEgressHandle(handlerFor({ ...scope, branch }))(request),
            ),
        };
      },
    } satisfies Egress;
  });
