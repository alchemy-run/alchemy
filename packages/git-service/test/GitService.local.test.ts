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
import GitWorker from "../src/GitWorker.ts";
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
// `Alchemy.localState()` rather than reusing `GitStack` (whose state store is
// `Cloudflare.state()`). Importing `./fixtures/stack.ts` above installed the
// TEST_ADMIN_TOKEN into the deployer env before this plan resolves
// `Config.redacted("GIT_SERVICE_ADMIN_TOKEN")`.
const LocalStack = Alchemy.Stack(
  "GitServiceLocalStack",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* GitWorker;
    return { url: worker.url.as<string>() };
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

    // repo tokens are not the admin key: create → 403, list → 401
    const repoToken = yield* makeClient(url, created.token.token);
    const forbidden = yield* expectTag(
      repoToken.repos.create({ payload: { owner: "acme", name: "other" } }),
      "Forbidden",
    );
    expect((forbidden as { required?: string }).required).toBe("admin");
    yield* expectTag(repoToken.repos.list({ query: {} }), "Unauthorized");
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
