import {
  bodyBytes,
  bufferBody,
  type CredentialInput,
  type EgressHandler,
  type EgressSecret,
  peekBody,
  refuse,
  uniqueBindingName,
} from "alchemy/Egress/Handler";
import {
  checkSubject,
  type ConfiguredEgress,
  ConfiguredEgressTypeId,
  type EgressKind,
  EgressKindTypeId,
  EgressNotServed,
  type EgressRequest,
  resolveCredential,
  type RouteSpec,
} from "alchemy/Egress/Kind";
import { ghCliLayer, gitCliLayer } from "alchemy/Image/CliLayers";
import type { ImageLayer } from "alchemy/Image/Layer";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
/**
 * GitHub egress: `gh` and `git` in a sandbox work with a placeholder token,
 * while an egress gateway checks each request against the declared
 * repositories, permissions and scope, adds the real token, and forwards it.
 */
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import { GitHubCredentials } from "./Credentials.ts";
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

/**
 * Narrow a GitHub egress to one repository, and optionally to one pull
 * request or issue in it.
 */
export interface Scope {
  /** `owner/name`. */
  readonly repository: string;
  /** Writes only to this issue (and branches `agent/issue-<n>/**`). */
  readonly issue?: number;
  /** Writes only to this pull request (and its head branch). */
  readonly pullRequest?: number;
  /**
   * Route GraphQL (`api.github.com/graphql`) to this egress. GraphQL can't be
   * split by path, so only one granted GitHub egress per sandbox can have it.
   * @default true
   */
  readonly graphql?: boolean;
}

/** A GitHub token: a secret bound into the host, or looked up per subject. */
export type GitHubToken =
  | EgressSecret
  | ((
      input: CredentialInput,
    ) => Effect.Effect<string | Redacted.Redacted<string>, unknown, RuntimeContext>);

/** Configures a GitHub egress in a gateway's constructor. */
export interface GatewayEgressOptions {
  /**
   * The token added to requests: a PAT, `GitHub.ProfileToken`, a `Config`, or
   * a function of the grant's subject (looked up per request, cached per
   * subject briefly). Never enters the sandbox.
   */
  readonly token: GitHubToken;
  /**
   * The repositories it may reach, and how. A grant can only narrow to one
   * of these. @default every repository the token can reach, with any access
   */
  readonly repositories?: ReadonlyArray<RepositoryAccess>;
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

/** Whether `bytes` hold a whole pkt-line command list (up to its flush-pkt). */
const pktHeadComplete = (bytes: Uint8Array) => {
  if (bytes.length > 1024 * 1024) return true;
  const text = new TextDecoder();
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = parseInt(text.decode(bytes.subarray(offset, offset + 4)), 16);
    if (Number.isNaN(length)) return true;
    if (length === 0) return true;
    if (length < 4) return true;
    offset += length;
  }
  return false;
};

//#region rules

/** Repository name → access. `undefined`: every repository, any access. */
type Policy = ReadonlyMap<string, RepositoryAccess> | undefined;

const FULL_ACCESS: RepositoryAccess = {
  repository: "*/*",
  contents: "write",
  pullRequests: "write",
  issues: "write",
  actions: "write",
  checks: "write",
  statuses: "write",
};

/** A scope, with the branch it may push to (a pull request's head, an issue's agent branches). */
type NarrowedScope = Scope & { readonly branch?: string };

interface Rules {
  readonly handlerFor: (scope: NarrowedScope | undefined) => EgressHandler;
  readonly branchFor: (scope: Scope) => Effect.Effect<string | undefined>;
}

const LEVEL = { read: 1, write: 2 } as const;

/** Bind each repository's `owner/name` into the host (a declared repository's name is an Output). */
const resolvePolicy = (repositories: ReadonlyArray<RepositoryAccess>) =>
  Effect.gen(function* () {
    const entries = yield* Effect.forEach(repositories, (access, i) =>
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
          yield* uniqueBindingName(`ALCHEMY_GITHUB_EGRESS_REPO_${i}`),
        ).asEffect() as unknown as Effect.Effect<Effect.Effect<string>>;
        return { access, name: Effect.map(fullName, (n) => n.toLowerCase()) };
      }),
    );
    return Effect.map(
      Effect.forEach(entries, ({ access, name }) => Effect.map(name, (n) => [n, access] as const)),
      (pairs): Policy => new Map(pairs),
    );
  });

/**
 * The GitHub egress rules for one token: classify each request (REST,
 * GraphQL, git), check it against the policy and scope, refuse in the form
 * the client shows, and add the token. Shared by the gateway and the
 * Durable Object that owns a Cloudflare container.
 */
const makeRules = (
  token: Effect.Effect<Redacted.Redacted<string>>,
  policy: Effect.Effect<Policy>,
): Rules => {
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
      if (nodes.size > 4096) nodes.clear();
      nodes.set(id, resolved);
      return resolved;
    });

  /** What a request is, in policy terms; the request (its body replayable); the pushed head. */
  const classify = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* (): Effect.fn.Return<{
      readonly classified: Classified;
      readonly request: HttpClientRequest.HttpClientRequest;
      readonly head?: Uint8Array;
    }> {
      const url = new URL(request.url);
      if (url.hostname === GIT_HOST) {
        const repo =
          /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
            url.pathname,
          );
        if (!repo) {
          return {
            classified: { kind: "deny", reason: `github.com${url.pathname} is not a git endpoint` },
            request,
          };
        }
        const repository = `${repo[1]}/${repo[2]}`.toLowerCase();
        const service = repo[3] === "info/refs" ? url.searchParams.get("service") : repo[3];
        if (service === "git-receive-pack" && repo[3] === "git-receive-pack") {
          // Only the command list is read; the pack streams through.
          const peeked =
            request.headers["content-encoding"] === "gzip"
              ? yield* Effect.flatMap(bufferBody(request), (buffered) =>
                  Effect.map(bodyBytes(buffered), (head) => ({ head, request: buffered })),
                )
              : yield* peekBody(request, pktHeadComplete);
          return {
            classified: {
              kind: "repo",
              repository,
              permission: "contents",
              write: true,
              refs: pushedRefs(peeked.head),
            },
            request: peeked.request,
            head: peeked.head,
          };
        }
        return {
          classified: {
            kind: "repo",
            repository,
            permission: "contents",
            write: service === "git-receive-pack",
          },
          request,
        };
      }
      if (url.pathname === "/graphql") {
        const buffered = yield* bufferBody(request);
        const text = new TextDecoder().decode(yield* bodyBytes(buffered));
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
          return {
            classified: repository
              ? { kind: "repo", repository, permission: "metadata", write: false }
              : { kind: "allow" },
            request: buffered,
          };
        }
        const permission = MUTATION_PERMISSION[mutation];
        if (permission === undefined) {
          return {
            classified: { kind: "deny", reason: `the GraphQL mutation ${mutation} is not allowed` },
            request: buffered,
          };
        }
        const input = (variables.input ?? variables) as Record<string, unknown>;
        const id = NODE_ID_FIELDS.map((field) => input[field]).find((v) => typeof v === "string");
        const node = typeof id === "string" ? yield* resolveNode(id) : undefined;
        if (!node?.repository) {
          return {
            classified: { kind: "deny", reason: `can't tell which repository ${mutation} changes` },
            request: buffered,
          };
        }
        return {
          classified: {
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
          },
          request: buffered,
        };
      }
      return { classified: classifyRest(request.method, url.pathname), request };
    });

  /** Allowed, or why not — against the policy (and an optional scope). */
  const authorize = (classified: Classified, scope: NarrowedScope | undefined) =>
    Effect.gen(function* () {
      if (classified.kind === "allow") return undefined;
      if (classified.kind === "deny") return classified.reason;
      const repositories = yield* policy;
      const access =
        repositories === undefined ? FULL_ACCESS : repositories.get(classified.repository);
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
        const branches =
          scope?.branch !== undefined ? [scope.branch] : (access.push?.branches ?? ["**"]);
        const allowed = branches.map(glob);
        const blocked = classified.refs.find(
          (ref) => !allowed.some((pattern) => pattern.test(ref.replace(/^refs\/heads\//, ""))),
        );
        if (blocked) {
          return `push to ${blocked} is not allowed (allowed: ${(scope?.branch !== undefined ? [scope.branch] : (access.push?.branches ?? [])).join(", ")})`;
        }
      }
      const target = scope?.pullRequest ?? scope?.issue;
      if (scope && target !== undefined && classified.write) {
        if (
          classified.creates === "issue" ||
          (scope.pullRequest !== undefined && classified.creates)
        ) {
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
    head: Uint8Array | undefined,
  ) =>
    Effect.gen(function* () {
      const message = `alchemy egress: ${reason}`;
      const url = new URL(request.url);
      if (classified.kind === "repo" && classified.refs && classified.refs.length > 0) {
        const first = new TextDecoder().decode(head ?? new Uint8Array()).split("\0")[1] ?? "";
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

  /** The branch a scope may push to (a pull request's head, looked up once). */
  const branches = new Map<string, string>();
  const branchFor = (scope: Scope) =>
    Effect.gen(function* () {
      if (scope.issue !== undefined) return `agent/issue-${scope.issue}/**`;
      if (scope.pullRequest === undefined) return undefined;
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
    handlerFor: (scope) => (incoming) =>
      Effect.gen(function* () {
        const { classified, request, head } = yield* classify(incoming);
        const reason = yield* authorize(classified, scope);
        if (reason !== undefined) return yield* refusal(request, classified, reason, head);
        return yield* authenticate(request);
      }),
    branchFor,
  };
};

//#endregion

/** What the sandbox's programs need: placeholders, and no prompts. */
const SANDBOX_ENV = { GH_TOKEN: PLACEHOLDER, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" };

const invalidScope = (message: string) => Effect.fail(new EgressNotServed({ message }));

const checkScope = (scope: unknown): Effect.Effect<Scope | undefined, EgressNotServed> => {
  if (scope === undefined) return Effect.succeed(undefined);
  const s = scope as Scope;
  if (
    typeof s !== "object" ||
    s === null ||
    typeof s.repository !== "string" ||
    !/^[^/\s]+\/[^/\s]+$/.test(s.repository)
  ) {
    return invalidScope("a GitHub scope needs { repository: 'owner/name' }");
  }
  if (s.issue !== undefined && s.pullRequest !== undefined) {
    return invalidScope("narrow to an issue or a pull request, not both");
  }
  return Effect.succeed(s);
};

/** The hosts and paths a GitHub egress covers (DESIGN.md §7). */
export const routesForScope = (scope: Scope | undefined): ReadonlyArray<RouteSpec> => {
  if (scope === undefined) {
    return [{ host: GIT_HOST }, ...API_HOSTS.map((host) => ({ host }))];
  }
  const repository = scope.repository;
  return [
    { host: GIT_HOST, paths: [`/${repository}/**`, `/${repository}.git/**`] },
    {
      host: "api.github.com",
      paths: [`/repos/${repository}/**`, ...(scope.graphql === false ? [] : ["/graphql"])],
    },
    { host: "uploads.github.com", paths: [`/repos/${repository}/**`] },
  ];
};

const gatewayEgress = (options: GatewayEgressOptions) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(
      options.token,
      "ALCHEMY_GITHUB_EGRESS_TOKEN",
      (secret): string | Redacted.Redacted<string> => secret,
    );
    const policy: Effect.Effect<Policy> = options.repositories
      ? yield* resolvePolicy(options.repositories)
      : Effect.succeed(undefined);

    // One set of rules (and their lookups) per credential.
    const cache = new Map<string, { readonly token: string; readonly rules: Rules }>();
    const rulesFor = (subject: string | undefined, token: Redacted.Redacted<string>) => {
      const key = subject ?? "";
      const value = Redacted.value(token);
      const cached = cache.get(key);
      if (cached && cached.token === value) return cached.rules;
      const rules = makeRules(Effect.succeed(token), policy);
      if (cache.size > 1024) cache.clear();
      cache.set(key, { token: value, rules });
      return rules;
    };

    const allows = (request: EgressRequest) =>
      Effect.gen(function* () {
        yield* checkSubject(credential.perSubject, request);
        const scope = yield* checkScope(request.scope);
        if (scope === undefined) return;
        const repositories = yield* policy;
        if (repositories !== undefined && !repositories.has(scope.repository.toLowerCase())) {
          return yield* new EgressNotServed({
            message: `${scope.repository} is not one of this egress's repositories`,
          });
        }
      });

    return {
      [ConfiguredEgressTypeId]: "GitHub",
      perSubject: credential.perSubject,
      allows,
      routes: (request) => Effect.map(checkScope(request.scope), routesForScope),
      handler: (request) =>
        Effect.gen(function* () {
          const scope = yield* checkScope(request.scope);
          const raw = yield* credential.get(request.subject);
          const token = Redacted.isRedacted(raw) ? raw : Redacted.make(raw);
          const rules = rulesFor(request.subject, token);
          if (scope === undefined) return rules.handlerFor(undefined);
          const branch = yield* rules.branchFor(scope);
          return rules.handlerFor({ ...scope, ...(branch !== undefined ? { branch } : {}) });
        }),
      env: SANDBOX_ENV,
      tools: [gitCliLayer, ghCliLayer],
    } satisfies ConfiguredEgress<"GitHub">;
  });

/** The `GitHub.Egress` kind, as named in a gateway or sandbox declaration. */
export interface Egress extends EgressKind<"GitHub", Scope> {
  /** Configure a GitHub egress in a gateway's constructor (`Egress.Gateway.serve`). */
  (options: GatewayEgressOptions): Effect.Effect<ConfiguredEgress<"GitHub">>;
  readonly env: Readonly<Record<string, string>>;
  readonly tools: ReadonlyArray<ImageLayer>;
}

/**
 * GitHub access without the token ever entering the sandbox: `gh` and `git`
 * (over HTTPS) work with a placeholder, while each request is checked
 * against `repositories` (deny by default) and the grant's scope, gets the
 * real token in an egress gateway, and is forwarded.
 *
 * Name it in a gateway declaration (`{ repo: GitHub.Egress }`) and configure
 * it in the gateway's constructor. A sandbox that accepts it
 * (`Sandbox.Sandbox<…, { egress: GitHub.Egress }>`) gets `git` and `gh`
 * installed at deploy, and `GH_TOKEN=alchemy-egress` when it is granted.
 *
 * ### Serving GitHub from a gateway
 * **Example:** Read-only access to one repository, with your GitHub login
 * ```typescript
 * export class RepoGateway extends Egress.Gateway<RepoGateway>()("RepoGateway", {
 *   repo: GitHub.Egress,
 * }) {}
 *
 * export default Cloudflare.Worker(
 *   "RepoGatewayWorker",
 *   { main: import.meta.url },
 *   RepoGateway.serve(
 *     Effect.gen(function* () {
 *       return {
 *         repo: yield* GitHub.Egress({
 *           token: GitHub.ProfileToken,
 *           repositories: [{ repository: "alchemy-run/alchemy", contents: "read" }],
 *         }),
 *       };
 *     }),
 *   ),
 * );
 * ```
 *
 * **Example:** Each user's own token, looked up per request
 * ```typescript
 * repo: yield* GitHub.Egress({
 *   token: ({ subject }) => tokens.get(subject).pipe(Effect.map((t) => t ?? "")),
 * }),
 * ```
 *
 * ### Granting it to a sandbox
 * **Example:** Pushes only to one issue's branches, from a Durable Object
 * ```typescript
 * export class Agent extends Cloudflare.DurableObject<Agent>()(
 *   "Agent",
 *   Effect.gen(function* () {
 *     const sandbox = yield* Sandbox;
 *     const gateway = yield* RepoGateway;
 *     return Effect.gen(function* () {
 *       return {
 *         work: (issue: number) =>
 *           sandbox.start({
 *             size: "large",
 *             egress: [gateway.repo.narrow({ repository: "alchemy-run/alchemy", issue })],
 *           }),
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
export const Egress: Egress = Object.assign(gatewayEgress, {
  [EgressKindTypeId]: "GitHub" as const,
  env: SANDBOX_ENV,
  tools: [gitCliLayer, ghCliLayer],
});
