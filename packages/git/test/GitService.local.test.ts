/**
 * THE PRIMARY SUITE — full local dev-mode coverage of git-service.
 *
 * `Test.make({ providers: Cloudflare.providers(), dev: true })` runs the
 * whole service on the local RPC-sidecar topology (`alchemy dev`'s process
 * shape): a local workerd Worker hosting the GitRepo/GitRegistry Durable
 * Objects and the R2 simulator. No cloud API is touched — the worker serves
 * from `http://localhost:<port>`.
 *
 * Coverage:
 *  (a) every REST endpooint of `GitApi` via the typed `HttpApiClient`
 *      (repos create/get/update/list/delete, refs list/get/update/remove
 *      with CAS, objects commit/log/tree/blob, tokens create/list/revoke,
 *      plus the raw blob/file streaming routes) including the typed
 *      401/403/404/409/422 error taxonomy;
 *  (b) the real `git` CLI over the smart-HTTP wire endpoints — empty clone,
 *      first push, clone-back + `git fsck --strict`, incremental fetch,
 *      force-push CAS, branch + annotated-tag lifecycle, readOnly rejection,
 *      and the wire auth matrix.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { GitApi, type Oid } from "../src/Api.ts";
import { GitService } from "../src/Service.ts";
import { TEST_ADMIN_TOKEN } from "./fixtures/stack.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The local suite must not touch the cloud, so it composes its own Stack over
// `Alchemy.localState()` — the same user pattern as production, just with a
// local state store: yield the `GitService()` construct inside your own
// Stack. Importing `./fixtures/stack.ts` above installed the
// TEST_ADMIN_TOKEN into the deployer env before this plan resolves
// `Config.redacted("GIT_SERVICE_ADMIN_TOKEN")`.
const LocalStack = Alchemy.Stack(
  "GitServiceLocalStack",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const git = yield* GitService();
    return { url: git.url };
  }),
);

// ── readiness ───────────────────────────────────────────────────────────────

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const boundedReadiness = Schedule.max([
  Schedule.min([
    Schedule.exponential("500 millis"),
    Schedule.spaced("2 seconds"),
  ]),
  Schedule.recurs(20),
]);

/** Wait until the local worker answers the admin repo listing with a 200. */
const awaitReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    yield* client
      .get(`${url}/api/v1/repos`, {
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      })
      .pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.void
            : Effect.fail(new WorkerNotReady({ status: res.status })),
        ),
        // retries transport errors (connection refused during boot) too
        Effect.retry({ schedule: boundedReadiness }),
      );
  }).pipe(Effect.orDie);

const stack = beforeAll(
  deploy(LocalStack).pipe(
    Effect.tap(({ url }) =>
      Effect.gen(function* () {
        // proof the run is local: no cloud URL, a localhost port
        expect(url).toMatch(/^http:\/\/localhost:\d+$/);
        yield* awaitReady(url);
      }),
    ),
    logLevel,
  ),
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(LocalStack));

// ── typed REST client ───────────────────────────────────────────────────────

const makeClient = (url: string, token: string) =>
  HttpApiClient.make(GitApi, {
    baseUrl: url,
    transformClient: HttpClient.mapRequest((request) =>
      request.pipe(HttpClientRequest.bearerToken(token)),
    ),
  });

/** A client that sends NO Authorization header — the anonymous caller. */
const makeAnonymousClient = (url: string) =>
  HttpApiClient.make(GitApi, { baseUrl: url });

const asOid = (oid: string): Oid => oid as Oid;

/** Assert an effect fails with the given tagged error. */
const expectTag = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
  tag: string,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe(tag);
      return result.failure;
    }
    return yield* Effect.die("unreachable");
  });

// ── git CLI plumbing ────────────────────────────────────────────────────────

class GitError extends Data.TaggedError("GitError")<{
  readonly args: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {}

/** Run `git <args>` in `cwd`, capturing exit code and output. Bounded. */
const git = Effect.fn(function* (cwd: string, ...args: Array<string>) {
  const handle = yield* ChildProcess.make("git", args, {
    cwd,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    extendEnv: true,
  });
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      handle.exitCode,
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
    ],
    { concurrency: 3 },
  );
  return { args, exitCode, stdout: stdout.trim(), stderr };
}, Effect.timeout("60 seconds"));

/** Run git and require exit 0, failing with the captured output otherwise. */
const mustGit = Effect.fn(function* (cwd: string, ...args: Array<string>) {
  const result = yield* git(cwd, ...args);
  if (result.exitCode !== 0) {
    return yield* new GitError(result);
  }
  return result;
});

/** Run git and require a non-zero exit (an expected rejection). */
const mustFailGit = Effect.fn(function* (cwd: string, ...args: Array<string>) {
  const result = yield* git(cwd, ...args);
  if (result.exitCode === 0) {
    return yield* new GitError(result);
  }
  return result;
});

/** `http://x:<token>@localhost:<port>/<owner>/<repo>.git` */
const authRemote = (url: string, token: string, owner: string, repo: string) =>
  Effect.sync(() => {
    const parsed = new URL(url);
    return `${parsed.protocol}//x:${token}@${parsed.host}/${owner}/${repo}.git`;
  });

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix: "git-service-local-" });
});

/** Create a repo via the admin REST client, returning its bootstrap token. */
/** Poll marker: repo still visible while its async purge drains. */
class StillDeleting extends Data.TaggedError("StillDeleting")<{}> {}

const createRepo = Effect.fn(function* (
  url: string,
  owner: string,
  name: string,
) {
  const client = yield* makeClient(url, TEST_ADMIN_TOKEN);
  // Retry-safe: a previous (failed, runner-retried) attempt may have left
  // the repo behind — delete it and wait out the async purge before
  // creating, so the create below never 409s on our own leftovers.
  yield* client.repos.delete({ params: { owner, repo: name } }).pipe(
    Effect.flatMap(() =>
      client.repos.get({ params: { owner, repo: name } }).pipe(
        Effect.flatMap(() => Effect.fail(new StillDeleting())),
        Effect.catchTag("RepoNotFound", () => Effect.void),
        Effect.retry({
          while: (error) => error instanceof StillDeleting,
          schedule: Schedule.spaced("250 millis"),
          times: 40,
        }),
      ),
    ),
    Effect.catchTag("RepoNotFound", () => Effect.void),
  );
  const created = yield* client.repos.create({ payload: { owner, name } });
  return {
    client,
    created,
    token: created.token.token,
    remote: yield* authRemote(url, created.token.token, owner, name),
  };
});

// ═══════════════════════════════════════════════════════════════════════════
// (a) REST management plane
// ═══════════════════════════════════════════════════════════════════════════

test(
  "repos: create, duplicate 409, get, list, update, typed auth failures",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const admin = yield* makeClient(url, TEST_ADMIN_TOKEN);

    const created = yield* admin.repos.create({
      payload: { owner: "acme", name: "rest-repos", description: "d0" },
    });
    expect(created.repo.owner).toBe("acme");
    expect(created.repo.name).toBe("rest-repos");
    expect(created.repo.status).toBe("ready");
    expect(created.repo.defaultBranch).toBe("main");
    expect(created.repo.readOnly).toBe(false);
    expect(created.remote).toContain("/acme/rest-repos.git");
    expect(created.token.token.startsWith("gs_")).toBe(true);
    expect(created.token.scope).toBe("write");

    // duplicate → typed 409
    yield* expectTag(
      admin.repos.create({ payload: { owner: "acme", name: "rest-repos" } }),
      "RepoAlreadyExists",
    );

    const fetched = yield* admin.repos.get({
      params: { owner: "acme", repo: "rest-repos" },
    });
    expect(fetched.repoId).toBe(created.repo.repoId);
    expect(fetched.description).toBe("d0");

    // list-all is admin-only and contains the repo
    const listed = yield* admin.repos.list({ query: {} });
    expect(
      listed.items.some((r) => r.owner === "acme" && r.name === "rest-repos"),
    ).toBe(true);

    // PATCH description + readOnly round-trip
    const patched = yield* admin.repos.update({
      params: { owner: "acme", repo: "rest-repos" },
      payload: { description: "d1", readOnly: true },
    });
    expect(patched.description).toBe("d1");
    expect(patched.readOnly).toBe(true);
    yield* admin.repos.update({
      params: { owner: "acme", repo: "rest-repos" },
      payload: { readOnly: false },
    });

    // missing repo → typed 404
    yield* expectTag(
      admin.repos.get({ params: { owner: "acme", repo: "does-not-exist" } }),
      "RepoNotFound",
    );

    // no credentials → typed 401 from the security middleware
    const anonymous = yield* HttpApiClient.make(GitApi, { baseUrl: url });
    yield* expectTag(
      anonymous.repos.get({ params: { owner: "acme", repo: "rest-repos" } }),
      "Unauthorized",
    );

    // garbage token → typed 401 (the Repo DO rejects it)
    const garbage = yield* makeClient(url, "gs_garbage-token");
    yield* expectTag(
      garbage.repos.get({ params: { owner: "acme", repo: "rest-repos" } }),
      "Unauthorized",
    );

    // repo tokens are not the admin key: create → 403; list succeeds but
    // shows PUBLIC repos only, so this private repo is not in it.
    const repoToken = yield* makeClient(url, created.token.token);
    const forbidden = yield* expectTag(
      repoToken.repos.create({ payload: { owner: "acme", name: "other" } }),
      "Forbidden",
    );
    expect((forbidden as { required?: string }).required).toBe("admin");
    const nonAdminListing = yield* repoToken.repos.list({ query: {} });
    expect(
      nonAdminListing.items.some(
        (row) => row.owner === "acme" && row.name === "rest-repos",
      ),
    ).toBe(false);
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "tokens: create scopes, masked list, revoke, TTL expiry",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { client: admin } = yield* createRepo(url, "acme", "rest-tokens");
    const params = { owner: "acme", repo: "rest-tokens" };

    const readToken = yield* admin.tokens.create({
      params,
      payload: { name: "ro", scope: "read" },
    });
    expect(readToken.token.startsWith("gs_")).toBe(true);
    expect(readToken.scope).toBe("read");

    // list is masked: TokenInfo rows never carry the token value
    const list = yield* admin.tokens.list({ params });
    expect(list.length).toBeGreaterThanOrEqual(2); // bootstrap + ro
    for (const info of list) {
      expect("token" in info).toBe(false);
    }

    // the read token reads but cannot manage tokens (admin scope required)
    const reader = yield* makeClient(url, readToken.token);
    const repo = yield* reader.repos.get({
      params: { owner: "acme", repo: "rest-tokens" },
    });
    expect(repo.name).toBe("rest-tokens");
    yield* expectTag(reader.tokens.list({ params }), "Forbidden");

    // revoke → token stops working; second revoke → typed 404
    yield* admin.tokens.revoke({ params: { ...params, id: readToken.id } });
    yield* expectTag(
      reader.repos.get({ params: { owner: "acme", repo: "rest-tokens" } }),
      "Unauthorized",
    );
    yield* expectTag(
      admin.tokens.revoke({ params: { ...params, id: readToken.id } }),
      "TokenNotFound",
    );

    // TTL expiry: a 5-second token works now and dies within the poll window
    const shortLived = yield* admin.tokens.create({
      params,
      payload: { name: "ttl", scope: "read", ttlSeconds: 5 },
    });
    const shortClient = yield* makeClient(url, shortLived.token);
    yield* shortClient.repos.get({
      params: { owner: "acme", repo: "rest-tokens" },
    });
    const expired = yield* shortClient.repos
      .get({ params: { owner: "acme", repo: "rest-tokens" } })
      .pipe(
        Effect.as(false),
        Effect.catchTag("Unauthorized", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (isExpired) => isExpired,
          times: 20,
        }),
      );
    expect(expired).toBe(true);
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "refs + objects: CAS writes, typed conflicts, commit/log/tree/blob reads, raw routes",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { client: admin, remote } = yield* createRepo(
      url,
      "acme",
      "rest-refs",
    );
    const params = { owner: "acme", repo: "rest-refs" };
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // refs on a fresh repo are empty
    const empty = yield* admin.refs.list({ params, query: {} });
    expect(empty.refs).toEqual([]);

    // seed real objects over the wire (2 commits)
    const tmp = yield* tempDir;
    yield* mustGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      remote,
      "work",
    );
    const work = path.join(tmp, "work");
    yield* fs.writeFileString(path.join(work, "hello.txt"), "hello local\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c1: seed");
    yield* fs.writeFileString(
      path.join(work, "hello.txt"),
      "hello local, v2\n",
    );
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c2: bump");
    yield* mustGit(work, "push", "origin", "main");
    const head = (yield* mustGit(work, "rev-parse", "HEAD")).stdout;
    const parent = (yield* mustGit(work, "rev-parse", "HEAD~1")).stdout;

    // refs.list / refs.get agree with the CLI
    const refs = yield* admin.refs.list({
      params,
      query: { prefix: "refs/heads/" },
    });
    expect(refs.refs.map((r) => r.name)).toEqual(["refs/heads/main"]);
    expect(refs.refs[0]!.oid).toBe(head);
    const mainRef = yield* admin.refs.get({
      params,
      query: { name: "refs/heads/main" },
    });
    expect(mainRef.oid).toBe(head);
    yield* expectTag(
      admin.refs.get({ params, query: { name: "refs/heads/nope" } }),
      "RefNotFound",
    );

    // CAS create (expectedOid: null = must-not-exist)
    const branch = yield* admin.refs.update({
      params,
      query: { name: "refs/heads/rest-branch" },
      payload: { newOid: asOid(parent), expectedOid: null },
    });
    expect(branch.oid).toBe(parent);
    // must-not-exist against an existing ref → typed 409
    yield* expectTag(
      admin.refs.update({
        params,
        query: { name: "refs/heads/rest-branch" },
        payload: { newOid: asOid(head), expectedOid: null },
      }),
      "RefConflict",
    );
    // stale expectedOid → typed 409
    yield* expectTag(
      admin.refs.update({
        params,
        query: { name: "refs/heads/rest-branch" },
        payload: { newOid: asOid(head), expectedOid: asOid(head) },
      }),
      "RefConflict",
    );
    // correct CAS moves the ref
    const moved = yield* admin.refs.update({
      params,
      query: { name: "refs/heads/rest-branch" },
      payload: { newOid: asOid(head), expectedOid: asOid(parent) },
    });
    expect(moved.oid).toBe(head);
    // pointing a ref at an object we do not have → typed 404
    yield* expectTag(
      admin.refs.update({
        params,
        query: { name: "refs/heads/rest-branch" },
        payload: { newOid: asOid("f".repeat(40)) },
      }),
      "ObjectNotFound",
    );
    // remove with a stale CAS → 409; with the right one → gone
    yield* expectTag(
      admin.refs.remove({
        params,
        query: { name: "refs/heads/rest-branch" },
        payload: { expectedOid: asOid(parent) },
      }),
      "RefConflict",
    );
    yield* admin.refs.remove({
      params,
      query: { name: "refs/heads/rest-branch" },
      payload: { expectedOid: asOid(head) },
    });
    yield* expectTag(
      admin.refs.get({ params, query: { name: "refs/heads/rest-branch" } }),
      "RefNotFound",
    );

    // readOnly gates REST ref writes with the typed 403
    yield* admin.repos.update({ params, payload: { readOnly: true } });
    yield* expectTag(
      admin.refs.update({
        params,
        query: { name: "refs/heads/blocked" },
        payload: { newOid: asOid(head) },
      }),
      "ReadOnlyRepo",
    );
    yield* admin.repos.update({ params, payload: { readOnly: false } });

    // objects: commit → tree → blob agree with the CLI byte-for-byte
    const commit = yield* admin.objects.commit({
      params: { ...params, oid: asOid(head) },
    });
    expect(commit.message).toContain("c2: bump");
    expect(commit.parents).toEqual([parent]);
    expect(commit.author.email).toBe("test@example.com");

    const tree = yield* admin.objects.tree({
      params: { ...params, oid: commit.tree },
    });
    const helloEntry = tree.entries.find((e) => e.name === "hello.txt")!;
    expect(helloEntry.type).toBe("blob");
    expect(helloEntry.mode).toBe("100644");

    const blob = yield* admin.objects.blob({
      params: { ...params, oid: helloEntry.oid },
    });
    expect(blob.encoding).toBe("base64");
    const blobText = yield* Effect.sync(() =>
      Buffer.from(blob.content, "base64").toString("utf8"),
    );
    expect(blobText).toBe("hello local, v2\n");

    // wrong-kind reads → typed 422
    yield* expectTag(
      admin.objects.tree({ params: { ...params, oid: helloEntry.oid } }),
      "WrongObjectType",
    );
    yield* expectTag(
      admin.objects.blob({ params: { ...params, oid: asOid(head) } }),
      "WrongObjectType",
    );
    yield* expectTag(
      admin.objects.commit({
        params: { ...params, oid: asOid("e".repeat(40)) },
      }),
      "ObjectNotFound",
    );

    // log walks the first-parent chain
    const log = yield* admin.objects.log({
      params,
      query: { ref: "refs/heads/main", limit: 10 },
    });
    expect(log.items.map((c) => c.oid)).toEqual([head, parent]);

    // raw streaming routes (outside HttpApi schema-land)
    const http = yield* HttpClient.HttpClient;
    const rawBlob = yield* http.get(
      `${url}/api/v1/repos/acme/rest-refs/blobs/${helloEntry.oid}/raw`,
      { headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` } },
    );
    expect(rawBlob.status).toBe(200);
    expect(yield* rawBlob.text).toBe("hello local, v2\n");

    const rawFile = yield* http.get(
      `${url}/api/v1/repos/acme/rest-refs/file?ref=refs/heads/main&path=hello.txt`,
      { headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` } },
    );
    expect(rawFile.status).toBe(200);
    expect(yield* rawFile.text).toBe("hello local, v2\n");
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "repos.delete: 204 now, async purge to a typed 404",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { client: admin } = yield* createRepo(url, "acme", "rest-delete");
    const params = { owner: "acme", repo: "rest-delete" };

    yield* admin.repos.delete({ params });

    // status flips to 'deleting' and the alarm-driven purge ends in a 404
    const gone = yield* admin.repos.get({ params }).pipe(
      Effect.map((repo) => ({ deleted: false, status: repo.status })),
      Effect.catchTag("RepoNotFound", () =>
        Effect.succeed({ deleted: true as const, status: undefined }),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (state) => state.deleted,
        times: 30,
      }),
    );
    expect(gone.deleted).toBe(true);
  }).pipe(logLevel),
  { timeout: 120_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// (b) real git CLI over the local wire
// ═══════════════════════════════════════════════════════════════════════════

test(
  "git: empty clone, first push (exec bit + subdir), REST agreement",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { client: admin, remote } = yield* createRepo(
      url,
      "acme",
      "wire-basic",
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;

    // empty-repo clone succeeds (unborn HEAD advertisement)
    const clone = yield* mustGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      remote,
      "work",
    );
    expect(`${clone.stdout}\n${clone.stderr}`).toContain("empty repository");
    const work = path.join(tmp, "work");

    // three commits: plain file, subdirectory, executable
    yield* fs.writeFileString(path.join(work, "hello.txt"), "hello wire\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c1: hello");
    yield* fs.makeDirectory(path.join(work, "sub"), { recursive: true });
    yield* fs.writeFileString(path.join(work, "sub", "nested.txt"), "nested\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c2: subdir");
    yield* fs.writeFileString(
      path.join(work, "run.sh"),
      "#!/bin/sh\necho ok\n",
    );
    yield* fs.chmod(path.join(work, "run.sh"), 0o755);
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c3: executable");

    yield* mustGit(work, "push", "origin", "main");
    const head = (yield* mustGit(work, "rev-parse", "HEAD")).stdout;

    // REST agrees with the CLI
    const params = { owner: "acme", repo: "wire-basic" };
    const refs = yield* admin.refs.list({ params, query: {} });
    expect(refs.refs.find((r) => r.name === "refs/heads/main")?.oid).toBe(head);

    const commit = yield* admin.objects.commit({
      params: { ...params, oid: asOid(head) },
    });
    expect(commit.message).toContain("c3: executable");
    const tree = yield* admin.objects.tree({
      params: { ...params, oid: commit.tree },
    });
    expect(tree.entries.find((e) => e.name === "run.sh")?.mode).toBe("100755");
    expect(tree.entries.find((e) => e.name === "sub")?.type).toBe("tree");

    // ls-remote sees exactly what REST sees
    const lsRemote = (yield* mustGit(work, "ls-remote", "origin")).stdout;
    expect(lsRemote).toContain(`${head}\trefs/heads/main`);
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "git: clone-back + fsck --strict, incremental fetch fast-forwards",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { remote } = yield* createRepo(url, "acme", "wire-fetch");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;

    // seed from clone A
    yield* mustGit(tmp, "-c", "init.defaultBranch=main", "clone", remote, "a");
    const a = path.join(tmp, "a");
    yield* fs.writeFileString(path.join(a, "file.txt"), "v1\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "c1");
    yield* fs.writeFileString(path.join(a, "file.txt"), "v2\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "c2");
    yield* mustGit(a, "push", "origin", "main");

    // clone-back is fsck-clean and log-identical — transitively proves
    // advertisement, negotiation, pack emission, and object round-tripping
    yield* mustGit(tmp, "clone", remote, "b");
    const b = path.join(tmp, "b");
    yield* mustGit(b, "fsck", "--strict");
    const logA = (yield* mustGit(a, "log", "--format=%H %s")).stdout;
    const logB = (yield* mustGit(b, "log", "--format=%H %s")).stdout;
    expect(logB).toBe(logA);

    // two more commits in A → B fetches incrementally (the haves/ACK path)
    yield* fs.writeFileString(path.join(a, "file.txt"), "v3\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "c3");
    yield* fs.writeFileString(path.join(a, "extra.txt"), "extra\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "c4");
    yield* mustGit(a, "push", "origin", "main");
    const headA = (yield* mustGit(a, "rev-parse", "HEAD")).stdout;

    yield* mustGit(b, "fetch", "origin");
    yield* mustGit(b, "merge", "--ff-only", "origin/main");
    expect((yield* mustGit(b, "rev-parse", "HEAD")).stdout).toBe(headA);
    expect(yield* fs.readFileString(path.join(b, "file.txt"))).toBe("v3\n");
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "git: force-push CAS, branch + annotated tag lifecycle",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { client: admin, remote } = yield* createRepo(
      url,
      "acme",
      "wire-refs",
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;
    const params = { owner: "acme", repo: "wire-refs" };

    yield* mustGit(tmp, "-c", "init.defaultBranch=main", "clone", remote, "a");
    const a = path.join(tmp, "a");
    yield* fs.writeFileString(path.join(a, "f.txt"), "one\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "c1");
    yield* fs.writeFileString(path.join(a, "f.txt"), "two\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "c2");
    yield* mustGit(a, "push", "origin", "main");

    // B clones now, then A advances the remote — B's next push is stale
    yield* mustGit(tmp, "clone", remote, "b");
    const b = path.join(tmp, "b");
    yield* fs.writeFileString(path.join(a, "f.txt"), "three\n");
    yield* mustGit(a, "add", "-A");
    yield* mustGit(a, "commit", "-m", "c3");
    yield* mustGit(a, "push", "origin", "main");

    // B pushes its own commit against the stale old-oid → server-side CAS ng
    yield* fs.writeFileString(path.join(b, "g.txt"), "divergent\n");
    yield* mustGit(b, "add", "-A");
    yield* mustGit(b, "commit", "-m", "divergent");
    const rejected = yield* mustFailGit(b, "push", "origin", "main");
    expect(`${rejected.stdout}\n${rejected.stderr}`).toContain("rejected");

    // fetch + force overwrites; A fetches the forced history cleanly
    yield* mustGit(b, "fetch", "origin");
    yield* mustGit(b, "push", "--force", "origin", "main");
    const headB = (yield* mustGit(b, "rev-parse", "HEAD")).stdout;
    yield* mustGit(a, "fetch", "origin");
    expect((yield* mustGit(a, "rev-parse", "origin/main")).stdout).toBe(headB);

    // annotated tag round-trips as a tag object with a peeled advertisement
    yield* mustGit(b, "tag", "-a", "v1", "-m", "release v1");
    yield* mustGit(b, "push", "origin", "v1");
    const tagOid = (yield* mustGit(b, "rev-parse", "v1")).stdout;
    const tagRef = yield* admin.refs.get({
      params,
      query: { name: "refs/tags/v1" },
    });
    expect(tagRef.oid).toBe(tagOid);
    expect(tagRef.peeled).toBe(headB); // peeled to the commit it annotates
    const lsRemote = (yield* mustGit(b, "ls-remote", "--tags", "origin"))
      .stdout;
    expect(lsRemote).toContain(`${tagOid}\trefs/tags/v1`);
    expect(lsRemote).toContain(`${headB}\trefs/tags/v1^{}`);

    // branch push + delete-refs for branch and tag
    yield* mustGit(b, "push", "origin", "main:feature");
    const feature = yield* admin.refs.get({
      params,
      query: { name: "refs/heads/feature" },
    });
    expect(feature.oid).toBe(headB);
    yield* mustGit(b, "push", "origin", "--delete", "feature");
    yield* mustGit(b, "push", "origin", "--delete", "v1");
    yield* expectTag(
      admin.refs.get({ params, query: { name: "refs/heads/feature" } }),
      "RefNotFound",
    );
    yield* expectTag(
      admin.refs.get({ params, query: { name: "refs/tags/v1" } }),
      "RefNotFound",
    );
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "git: readOnly repos reject pushes in-band, then accept after unflag",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { client: admin, remote } = yield* createRepo(
      url,
      "acme",
      "wire-readonly",
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;
    const params = { owner: "acme", repo: "wire-readonly" };

    yield* mustGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      remote,
      "work",
    );
    const work = path.join(tmp, "work");
    yield* fs.writeFileString(path.join(work, "f.txt"), "one\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c1");
    yield* mustGit(work, "push", "origin", "main");

    yield* admin.repos.update({ params, payload: { readOnly: true } });
    yield* fs.writeFileString(path.join(work, "f.txt"), "two\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c2");
    const rejected = yield* mustFailGit(work, "push", "origin", "main");
    expect(`${rejected.stdout}\n${rejected.stderr}`).toContain("rejected");

    yield* admin.repos.update({ params, payload: { readOnly: false } });
    yield* mustGit(work, "push", "origin", "main");
    const head = (yield* mustGit(work, "rev-parse", "HEAD")).stdout;
    const mainRef = yield* admin.refs.get({
      params,
      query: { name: "refs/heads/main" },
    });
    expect(mainRef.oid).toBe(head);
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "git: wire auth matrix — garbage token 401s, read token clones but cannot push",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { client: admin, remote } = yield* createRepo(
      url,
      "acme",
      "wire-auth",
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;
    const params = { owner: "acme", repo: "wire-auth" };

    // seed one commit with the bootstrap write token
    yield* mustGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      remote,
      "seed",
    );
    const seed = path.join(tmp, "seed");
    yield* fs.writeFileString(path.join(seed, "f.txt"), "seed\n");
    yield* mustGit(seed, "add", "-A");
    yield* mustGit(seed, "commit", "-m", "c1");
    yield* mustGit(seed, "push", "origin", "main");

    // garbage token → 401 before any pack bytes flow. git surfaces the 401
    // as "Authentication failed" (it never echoes the literal status code).
    const badRemote = yield* authRemote(url, "gs_garbage", "acme", "wire-auth");
    const unauthorized = yield* mustFailGit(tmp, "clone", badRemote, "nope");
    expect(unauthorized.stderr).toContain("Authentication failed");

    // a read-scope token clones (token in the remote URL) but cannot push
    const readToken = yield* admin.tokens.create({
      params,
      payload: { name: "ro", scope: "read" },
    });
    const readRemote = yield* authRemote(
      url,
      readToken.token,
      "acme",
      "wire-auth",
    );
    yield* mustGit(tmp, "clone", readRemote, "ro");
    const ro = path.join(tmp, "ro");
    yield* mustGit(ro, "fsck", "--strict");
    yield* fs.writeFileString(path.join(ro, "f.txt"), "denied\n");
    yield* mustGit(ro, "add", "-A");
    yield* mustGit(ro, "commit", "-m", "denied");
    yield* mustFailGit(ro, "push", "origin", "main");

    // the write path still works for the bootstrap token
    yield* fs.writeFileString(path.join(seed, "f.txt"), "seed2\n");
    yield* mustGit(seed, "add", "-A");
    yield* mustGit(seed, "commit", "-m", "c2");
    yield* mustGit(seed, "push", "origin", "main");
  }).pipe(logLevel),
  { timeout: 120_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// v2 storage plane: compaction (DESIGN.md §12.1)
// ═══════════════════════════════════════════════════════════════════════════

test(
  "compaction: objects move into an R2 pack and clones stay byte-identical",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* createRepo(url, "acme", "compaction");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;

    // A history with enough distinct blobs that a compaction run has real
    // work to do, plus one binary file whose bytes must survive exactly.
    yield* mustGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      repo.remote,
      "work",
    );
    const work = path.join(tmp, "work");
    const binary = new Uint8Array(4096);
    for (let i = 0; i < binary.length; i++) binary[i] = (i * 31 + 7) & 0xff;
    yield* fs.writeFile(path.join(work, "blob.bin"), binary);
    for (let i = 0; i < 12; i++) {
      yield* fs.writeFileString(path.join(work, `f${i}.txt`), `content ${i}\n`);
    }
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "seed");
    yield* mustGit(work, "push", "origin", "main");

    // Compaction is normally armed by size thresholds; force a run now so
    // the test does not depend on repo size.
    yield* repo.client.repos.compact({
      params: { owner: "acme", repo: "compaction" },
    });

    const stats = yield* repo.client.repos
      .get({ params: { owner: "acme", repo: "compaction" } })
      .pipe(
        Effect.map((found) => found.objects),
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (objects: { loose: number; packed: number }) =>
            objects.packed > 0 && objects.loose === 0,
          times: 40,
        }),
      );
    expect(stats.packed).toBeGreaterThan(0);
    expect(stats.loose).toBe(0);

    // Everything now reads through R2 ranged GETs: a fresh clone must be
    // fsck-clean and byte-identical, and REST blob reads must still work.
    yield* mustGit(tmp, "clone", repo.remote, "verify");
    const verify = path.join(tmp, "verify");
    yield* mustGit(verify, "fsck", "--strict");
    const round = yield* fs.readFile(path.join(verify, "blob.bin"));
    expect(Array.from(round)).toEqual(Array.from(binary));
    for (let i = 0; i < 12; i++) {
      const text = yield* fs.readFileString(path.join(verify, `f${i}.txt`));
      expect(text).toBe(`content ${i}\n`);
    }

    // ...and an incremental push on top of a fully packed repo still works.
    yield* fs.writeFileString(path.join(work, "after.txt"), "after\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "after-compaction");
    yield* mustGit(work, "push", "origin", "main");
    yield* mustGit(verify, "pull", "origin", "main");
    expect(yield* fs.readFileString(path.join(verify, "after.txt"))).toBe(
      "after\n",
    );
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "clone bundles: a full clone is served from the R2 bundle, byte-identically",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* createRepo(url, "acme", "bundles");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;

    yield* mustGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      repo.remote,
      "work",
    );
    const work = path.join(tmp, "work");
    yield* fs.writeFileString(path.join(work, "a.txt"), "one\n");
    yield* fs.makeDirectory(path.join(work, "sub"), { recursive: true });
    yield* fs.writeFileString(path.join(work, "sub", "b.txt"), "two\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c1");
    yield* mustGit(work, "push", "origin", "main");
    const head = (yield* mustGit(work, "rev-parse", "HEAD")).stdout;

    // The bundle is cut by the post-push alarm; wait for it to land, then
    // clone — that clone is served straight from the R2 bundle bytes.
    yield* Effect.sleep("4 seconds");
    yield* mustGit(tmp, "clone", repo.remote, "fromBundle");
    const fromBundle = path.join(tmp, "fromBundle");
    yield* mustGit(fromBundle, "fsck", "--strict");
    expect((yield* mustGit(fromBundle, "rev-parse", "HEAD")).stdout).toBe(head);
    expect(yield* fs.readFileString(path.join(fromBundle, "a.txt"))).toBe(
      "one\n",
    );
    expect(
      yield* fs.readFileString(path.join(fromBundle, "sub", "b.txt")),
    ).toBe("two\n");

    // A push after the bundle was cut invalidates it: the next clone must
    // still see the NEW commit (served dynamically, or from a fresh bundle).
    yield* fs.writeFileString(path.join(work, "c.txt"), "three\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c2");
    yield* mustGit(work, "push", "origin", "main");
    const head2 = (yield* mustGit(work, "rev-parse", "HEAD")).stdout;
    yield* mustGit(tmp, "clone", repo.remote, "afterPush");
    const afterPush = path.join(tmp, "afterPush");
    yield* mustGit(afterPush, "fsck", "--strict");
    expect((yield* mustGit(afterPush, "rev-parse", "HEAD")).stdout).toBe(head2);

    // A single-branch clone is covered by the same (superset) bundle.
    yield* Effect.sleep("4 seconds");
    yield* mustGit(
      tmp,
      "clone",
      "--single-branch",
      "--branch",
      "main",
      repo.remote,
      "single",
    );
    yield* mustGit(path.join(tmp, "single"), "fsck", "--strict");
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "clone bundles: the wire response proves the R2 fast path served it",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* createRepo(url, "acme", "bundle-wire");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* tempDir;

    yield* mustGit(
      tmp,
      "-c",
      "init.defaultBranch=main",
      "clone",
      repo.remote,
      "work",
    );
    const work = path.join(tmp, "work");
    yield* fs.writeFileString(path.join(work, "f.txt"), "hello\n");
    yield* mustGit(work, "add", "-A");
    yield* mustGit(work, "commit", "-m", "c1");
    yield* mustGit(work, "push", "origin", "main");
    const head = (yield* mustGit(work, "rev-parse", "HEAD")).stdout;

    yield* Effect.sleep("4 seconds");

    // Hand-built v0 upload-pack request: one `want`, flush, `done` — the
    // shape a fresh clone sends. No capabilities, so the response is
    // `NAK` followed by the raw pack.
    const pkt = (line: string) =>
      `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
    const body = `${pkt(`want ${head}\n`)}0000${pkt("done\n")}`;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(
        `${url}/acme/bundle-wire.git/git-upload-pack`,
      ).pipe(
        HttpClientRequest.setHeaders({
          authorization: `Bearer ${repo.token}`,
          "content-type": "application/x-git-upload-pack-request",
        }),
        HttpClientRequest.bodyText(body),
      ),
    );
    expect(response.status).toBe(200);
    // The header is only set on the bundle path (DESIGN.md §12.2).
    expect(response.headers["x-git-bundle"]).toBeDefined();

    const bytes = yield* response.arrayBuffer.pipe(
      Effect.map((buffer) => new Uint8Array(buffer)),
    );
    const text = new TextDecoder().decode(bytes.subarray(0, 8));
    expect(text).toBe("0008NAK\n");
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("PACK");
  }).pipe(logLevel),
  { timeout: 120_000 },
);

// ═══════════════════════════════════════════════════════════════════════════
// (j) public repos — anonymous read access (GitHub model)
// ═══════════════════════════════════════════════════════════════════════════

test(
  "public repos: anonymous REST reads + tokenless clone; writes still need a token",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const admin = yield* makeClient(url, TEST_ADMIN_TOKEN);
    const anonymous = yield* makeAnonymousClient(url);
    const tmp = yield* tempDir;
    const path = yield* Path.Path;

    // A public repo with one commit pushed by its owner.
    const repo = yield* createRepo(url, "acme", "town-square");
    yield* admin.repos.update({
      params: { owner: "acme", repo: "town-square" },
      payload: { public: true },
    });
    const fs = yield* FileSystem.FileSystem;
    const pub = path.join(tmp, "pub");
    yield* fs.makeDirectory(pub, { recursive: true });
    yield* mustGit(pub, "init", "-q", "-b", "main");
    yield* fs.writeFileString(
      path.join(pub, "greeting.txt"),
      "hello anonymous\n",
    );
    yield* mustGit(pub, "add", "-A");
    yield* mustGit(pub, "commit", "-qm", "public commit");
    yield* mustGit(pub, "push", "-q", repo.remote, "main");

    // Anonymous REST: repo meta, refs, log, tree, blob — no token anywhere.
    const meta = yield* anonymous.repos.get({
      params: { owner: "acme", repo: "town-square" },
    });
    expect(meta.public).toBe(true);
    const refs = yield* anonymous.refs.list({
      params: { owner: "acme", repo: "town-square" },
      query: {},
    });
    expect(refs.head).toBe("refs/heads/main");
    const head = refs.refs.find((ref) => ref.name === "refs/heads/main")!;
    const commit = yield* anonymous.objects.commit({
      params: { owner: "acme", repo: "town-square", oid: head.oid },
    });
    expect(commit.message).toContain("public commit");
    const log = yield* anonymous.objects.log({
      params: { owner: "acme", repo: "town-square" },
      query: {},
    });
    expect(log.items.length).toBe(1);

    // Anonymous listing shows the public repo (admin key not required).
    const listing = yield* anonymous.repos.list({ query: {} });
    expect(listing.items.some((row) => row.name === "town-square")).toBe(true);

    // Tokenless clone over the wire.
    const parsed = new URL(url);
    const anonymousRemote = `${parsed.protocol}//${parsed.host}/acme/town-square.git`;
    yield* mustGit(tmp, `clone`, `-q`, anonymousRemote, `anon-clone`);
    const cloned = yield* mustGit(
      path.join(tmp, "anon-clone"),
      `show`,
      `HEAD:greeting.txt`,
    );
    expect(cloned.stdout.trim()).toBe("hello anonymous");

    // Writes stay locked: anonymous push is rejected (401 → git fails).
    const anonWork = path.join(tmp, "anon-clone");
    yield* fs.writeFileString(
      path.join(anonWork, "greeting.txt"),
      "hello anonymous\nmore\n",
    );
    yield* mustGit(anonWork, "add", "-A");
    yield* mustGit(anonWork, "commit", "-qm", "anon write");
    const push = yield* Effect.result(
      mustGit(anonWork, "push", "-q", "origin", "main"),
    );
    expect(Result.isFailure(push)).toBe(true);

    // Anonymous token management is rejected too.
    yield* expectTag(
      anonymous.tokens.list({
        params: { owner: "acme", repo: "town-square" },
      }),
      "Unauthorized",
    );

    // Flipping back to private locks anonymous readers out again.
    yield* admin.repos.update({
      params: { owner: "acme", repo: "town-square" },
      payload: { public: false },
    });
    yield* expectTag(
      anonymous.repos.get({ params: { owner: "acme", repo: "town-square" } }),
      "Unauthorized",
    );
    const privateListing = yield* anonymous.repos.list({ query: {} });
    expect(privateListing.items.some((row) => row.name === "town-square")).toBe(
      false,
    );
    const privateClone = yield* Effect.result(
      mustGit(tmp, `clone`, `-q`, anonymousRemote, `anon-clone-private`),
    );
    expect(Result.isFailure(privateClone)).toBe(true);
  }),
  { timeout: 120_000 },
);
