import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import Stack from "./fixtures/stack.ts";

/**
 * Artifacts ("Git for agents") is a beta product whose native Worker binding +
 * implicit-namespace REST surface require the account to be onboarded to the
 * beta. The standing test account IS entitled, so this suite runs live by
 * default: the effect-native worker drives the full namespace + repository
 * surface (create / list / listAll / get / info / import / tokens / fork /
 * log / readCommit / readTree / readBlob / readFile / delete) and the async
 * worker a create / list / get / delete round-trip over the raw binding.
 *
 * If an account is NOT onboarded, repo creation is rejected at runtime; set
 * `CLOUDFLARE_TEST_ARTIFACTS=0` to skip the entire suite skip-clean on such an
 * account.
 */
const ARTIFACTS_ENABLED = process.env.CLOUDFLARE_TEST_ARTIFACTS !== "0";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const HOOK_TIMEOUT = 300_000;
// Must cover the ~150s `ready` readiness budget plus the round-trip itself.
const TEST_TIMEOUT = 240_000;

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {
  override get message() {
    return `status=${this.status} body=${this.body.slice(0, 500)}`;
  }
}

class RouteFailed extends Data.TaggedError("RouteFailed")<{ body: string }> {
  override get message() {
    return this.body;
  }
}

// Bounded spaced schedule — caps total cold-start wait so a real failure
// surfaces fast instead of riding to the test timeout. ~150s: fresh
// workers.dev URLs 404 well past a minute under full-suite deploy load.
const ready = Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(75)]);

/** Retry an HTTP call until it returns 200 (rides out cold-start 404s). */
const untilOk = <E, R>(eff: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>) =>
  eff.pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.succeed(res)
        : res.text.pipe(
            Effect.flatMap((body) =>
              // A typed binding error surfaced by the fixture's routes is a
              // real failure — fail fast instead of riding the readiness retry.
              Effect.fail<RouteFailed | WorkerNotReady>(
                res.status === 500 && body.startsWith('{"error"')
                  ? new RouteFailed({ body })
                  : new WorkerNotReady({ status: res.status, body }),
              ),
            ),
          ),
    ),
    Effect.retry({
      while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
      schedule: ready,
    }),
  );

const body = <T>(res: HttpClientResponse.HttpClientResponse) =>
  res.json.pipe(Effect.map((b) => b as T));

const call = <T>(base: string, method: "GET" | "POST" | "DELETE", path: string) =>
  untilOk(HttpClient.execute(HttpClientRequest.make(method)(`${base}${path}`))).pipe(
    Effect.flatMap((res) => body<T>(res)),
  );

const q = (params: Record<string, string>) => `?${new URLSearchParams(params).toString()}`;

const getRepo = (base: string, name: string) =>
  call<{ found: boolean; info?: { name: string; remote: string; defaultBranch: string } }>(
    base,
    "GET",
    `/get${q({ name })}`,
  );

const deleteRepo = (base: string, name: string) =>
  call<{ deleted: boolean }>(base, "DELETE", `/delete${q({ name })}`);

/** Delete a deterministic repo an interrupted earlier run may have leaked. */
const preClean = (base: string, name: string) =>
  Effect.gen(function* () {
    if ((yield* getRepo(base, name)).found) yield* deleteRepo(base, name);
  });

/**
 * The async worker only implements the original four routes (create / list /
 * get / delete) over the raw runtime binding.
 */
const exerciseAsync = (base: string) =>
  Effect.gen(function* () {
    const repo = "async-repo";
    const asyncGet = (name: string) => call<{ found: boolean }>(base, "GET", `/get${q({ name })}`);
    if ((yield* asyncGet(repo)).found) yield* deleteRepo(base, repo);

    const created = yield* call<{
      name: string;
      remote: string;
      defaultBranch: string;
      hasToken: boolean;
    }>(base, "POST", `/create${q({ name: repo })}`);
    expect(created.name).toBe(repo);
    expect(created.defaultBranch).toBe("main");
    expect(created.remote).toContain("https://");
    expect(created.hasToken).toBe(true);

    const listed = yield* call<{ names: string[] }>(base, "GET", "/list");
    expect(listed.names).toContain(repo);
    expect((yield* asyncGet(repo)).found).toBe(true);
    expect((yield* deleteRepo(base, repo)).deleted).toBe(true);
    expect((yield* asyncGet(repo)).found).toBe(false);
  });

/**
 * Drive the full Effect-native client surface: namespace create / list /
 * listAll / get / import / delete, and repo info / createToken / listTokens /
 * revokeToken / fork / log / readCommit / readTree / readBlob / readFile.
 */
const exerciseEffect = (base: string) =>
  Effect.gen(function* () {
    const repo = "effect-repo";
    const imported = "effect-import";
    const forked = "effect-fork";
    yield* preClean(base, repo);
    yield* preClean(base, imported);
    yield* preClean(base, forked);

    const created = yield* call<{
      name: string;
      remote: string;
      defaultBranch: string;
      hasToken: boolean;
    }>(base, "POST", `/create${q({ name: repo })}`);
    expect(created.name).toBe(repo);
    expect(created.defaultBranch).toBe("main");
    expect(created.hasToken).toBe(true);

    const info = yield* getRepo(base, repo);
    expect(info.found).toBe(true);
    expect(info.info?.name).toBe(repo);
    expect(info.info?.remote).toBe(created.remote);

    const tokens = yield* call<{
      scope: string;
      hasPlaintext: boolean;
      listed: boolean;
      revoked: boolean;
      revokedUnknown: boolean;
    }>(base, "POST", `/tokens${q({ name: repo })}`);
    expect(tokens).toEqual({
      scope: "read",
      hasPlaintext: true,
      listed: true,
      revoked: true,
      revokedUnknown: false,
    });

    const imp = yield* call<{ name: string; remote: string }>(
      base,
      "POST",
      `/import${q({ name: imported })}`,
    );
    expect(imp.name).toBe(imported);

    const content = yield* call<{
      empty: boolean;
      head: string;
      commitMatches: boolean;
      entries: string[];
      entry: string | undefined;
      blobMatchesFile: boolean;
      fileType: string | undefined;
      missingCommit: unknown;
    }>(base, "GET", `/content${q({ name: imported })}`);
    expect(content.empty).toBe(false);
    expect(content.head).toMatch(/^[0-9a-f]{40}$/);
    expect(content.commitMatches).toBe(true);
    expect(content.entries.length).toBeGreaterThan(0);
    expect(content.entry).toBeDefined();
    expect(content.blobMatchesFile).toBe(true);
    expect(content.missingCommit).toBeNull();

    const fork = yield* call<{ name: string }>(
      base,
      "POST",
      `/fork${q({ name: imported, target: forked })}`,
    );
    expect(fork.name).toBe(forked);

    const listed = yield* call<{
      pageSize: number;
      hasCursor: boolean;
      total: number;
      names: string[];
    }>(base, "GET", "/list");
    expect(listed.pageSize).toBe(1);
    expect(listed.total).toBeGreaterThanOrEqual(3);
    expect(listed.hasCursor).toBe(true);
    expect(listed.names).toEqual(expect.arrayContaining([repo, imported, forked]));

    for (const name of [forked, imported, repo]) {
      expect((yield* deleteRepo(base, name)).deleted).toBe(true);
      expect((yield* getRepo(base, name)).found).toBe(false);
    }
  });

// `beforeAll` has no `.skipIf`, so the deploy is gated inside the effect: when
// the Artifacts beta flag is unset, skip the (entitlement-blocked) deploy and
// return empty URLs. The tests below are `skipIf`-gated on the same flag, so
// they never read these placeholder URLs.
const stack = beforeAll(
  ARTIFACTS_ENABLED ? deploy(Stack) : Effect.succeed({ effectWorkerUrl: "", asyncWorkerUrl: "" }),
  { timeout: HOOK_TIMEOUT },
);
afterAll.skipIf(!ARTIFACTS_ENABLED || !!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: HOOK_TIMEOUT,
});

// Effect-native worker: `Cloudflare.Artifacts.ReadWriteNamespace(Repos)` + `ReadWriteNamespaceBinding`.
test.skipIf(!ARTIFACTS_ENABLED)(
  "effect binding: full namespace + repository surface",
  Effect.gen(function* () {
    const out = yield* stack;
    yield* exerciseEffect(out.effectWorkerUrl);
  }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:artifacts",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: TEST_TIMEOUT,
  },
);

// Async worker: namespace declared on `env: { REPOS }`, used from plain async fetch.
test.skipIf(!ARTIFACTS_ENABLED)(
  "async binding: create / list / get / delete round-trip",
  Effect.gen(function* () {
    const out = yield* stack;
    yield* exerciseAsync(out.asyncWorkerUrl);
  }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:artifacts",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: TEST_TIMEOUT,
  },
);
