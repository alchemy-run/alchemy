import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Daytona from "@alchemy.run/daytona";
import { DaytonaAuth } from "@alchemy.run/daytona/AuthProvider";
import { fromAuthProvider } from "@alchemy.run/daytona/Credentials";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as apiKeys from "@distilled.cloud/daytona/api_keys";
import * as sandboxes from "@distilled.cloud/daytona/sandbox";
import * as secretsApi from "@distilled.cloud/daytona/secret";
import * as volumesApi from "@distilled.cloud/daytona/volumes";
import * as Alchemy from "alchemy";
import { Stage } from "alchemy/Stage";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { DevBox } from "./fixtures/resources.ts";
import DaytonaWorker from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Daytona.providers(), Cloudflare.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "DaytonaBindingsStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const devBox = yield* DevBox;
    const worker = yield* DaytonaWorker;
    return { url: worker.url.as<string>(), stage: yield* Stage, devBox: devBox.sandboxId };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** The Worker answered 500: the route ran and failed, so there is nothing to retry. */
class RouteFailed extends Data.TaggedError("RouteFailed")<{ path: string; body: string }> {
  override get message() {
    return `${this.path} failed: ${this.body}`;
  }
}

/** Cloudflare hasn't routed the fresh workers.dev script yet (error 1104). */
class NotPropagated extends Data.TaggedError("NotPropagated")<{}> {}

const get = (path: string) =>
  Effect.gen(function* () {
    const { url, stage } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    // Retry only while the fresh workers.dev URL propagates: a non-2xx from
    // Cloudflare's edge, or its 500 "Script not found" page.
    const res = yield* client.get(`${url}${path}?prefix=${encodeURIComponent(stage)}`).pipe(
      Effect.flatMap((res) =>
        res.status === 500
          ? Effect.flatMap(res.text, (body) =>
              body.includes("Script not found")
                ? Effect.fail(new NotPropagated())
                : Effect.succeed({ res, body }),
            )
          : Effect.map(HttpClientResponse.filterStatusOk(res), (res) => ({ res, body: "" })),
      ),
      Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }),
    );
    if (res.res.status === 500) return yield* new RouteFailed({ path, body: res.body });
    return (yield* res.res.json) as any;
  });

/**
 * Delete a runtime volume by name, retrying while a sandbox being deleted
 * still mounts it.
 */
const deleteVolumeByName = (name: string) =>
  volumesApi.getVolumeByName({ name }).pipe(
    Effect.flatMap((v) => volumesApi.deleteVolume({ volumeId: v.id })),
    Effect.retry({
      while: (e) => e._tag === "VolumeInUse" || e._tag === "VolumeNotReady",
      schedule: Schedule.spaced("3 seconds"),
      times: 20,
    }),
    Effect.catchTag("VolumeNotFound", () => Effect.void),
  );

/** Out-of-band reads with the deployer's credentials. */
const outOfBand = Effect.provide(fromAuthProvider().pipe(Layer.provide(DaytonaAuth)));

const tags = ["provider:daytona", "provider:cloudflare", "provider:cloudflare:worker", "live"];

describe("CreateSandbox", () => {
  test(
    "creates a sandbox, runs a command, finds and lists it, deletes it",
    Effect.gen(function* () {
      const body = yield* get("/create-sandbox");
      expect(body).toMatchObject({
        echo: { exitCode: 0, result: expect.stringContaining("hello") },
        size: expect.any(Number),
        found: true,
        listed: true,
      });
      expect(body.size).toBeGreaterThan(0);
      // The sandbox was deleted when the request's scope closed.
      const { stage } = yield* stack;
      const left = yield* sandboxes
        .getSandbox({ sandboxIdOrName: `alchemy-bindings-${stage}` })
        .pipe(
          Effect.map((s) => s.state),
          Effect.catchTag("SandboxNotFound", () => Effect.succeed("destroyed" as const)),
        );
      expect(["destroyed", "destroying"]).toContain(left);
    }).pipe(outOfBand),
    { tags, timeout: 300_000 },
  );

  test(
    "the Worker's key has only the sandbox permissions",
    Effect.gen(function* () {
      const keys = yield* apiKeys.listApiKeys({});
      // Physical names are truncated: ...-daytonaworkersandb<suffix>.
      const key = keys.find((k) => k.name.includes("daytonaworkersandb"));
      expect([...(key?.permissions ?? [])].sort()).toEqual(["delete:sandboxes", "write:sandboxes"]);
    }).pipe(outOfBand),
    { tags, timeout: 60_000 },
  );
});

describe("runtime objects", () => {
  test(
    "objects a binding creates are tagged with the stack, stage and host",
    Effect.gen(function* () {
      const { stage } = yield* stack;
      const created = (yield* get("/tagged")) as { sandboxId: string; secret: string };
      // The test owns what the route created: delete it before destroy.
      yield* Effect.addFinalizer(() =>
        Effect.all(
          [
            sandboxes
              .deleteSandbox({ sandboxIdOrName: created.sandboxId })
              .pipe(Effect.catchTag("SandboxNotFound", () => Effect.void)),
            secretsApi.listSecretsPaginated.items({}).pipe(
              Stream.filter((s) => s.name === created.secret),
              Stream.runForEach((s) => secretsApi.deleteSecret({ secretId: s.id })),
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.ignore, outOfBand),
      );
      const sandbox = yield* sandboxes.getSandbox({ sandboxIdOrName: created.sandboxId });
      expect(sandbox.labels).toMatchObject({
        "alchemy.stack": "DaytonaBindingsStack",
        "alchemy.stage": stage,
        "alchemy.id": "DaytonaWorker",
        purpose: "tag-test",
      });
      const secret = yield* secretsApi.listSecretsPaginated.items({}).pipe(
        Stream.filter((s) => s.name === created.secret),
        Stream.runHead,
      );
      expect(Option.getOrUndefined(secret)?.description).toBe(
        `tag test (DaytonaBindingsStack/${stage}/DaytonaWorker)`,
      );
    }).pipe(outOfBand, Effect.scoped),
    { tags, timeout: 300_000 },
  );
});

describe("CreateSandbox lifecycle", () => {
  test.skipIf(!!process.env.FAST)(
    "signed preview, SSH, signing keys, settings, reads and stop/start; fork, pause and resize refused",
    Effect.gen(function* () {
      const { stage } = yield* stack;
      // The route's home volume outlives the stack: delete it once the
      // route's sandbox (which mounts it) is gone.
      yield* Effect.addFinalizer(() =>
        deleteVolumeByName(`alchemy-bindings-home-${stage}`).pipe(Effect.ignore, outOfBand),
      );
      expect(yield* get("/sandbox-lifecycle")).toEqual({
        page: { status: 200, body: "signed-ok" },
        ssh: true,
        key: true,
        rotated: true,
        // Daytona Cloud forks only some sandbox classes; the default snapshot's isn't one.
        fork: "ForkNotSupported",
        // Container sandboxes can't pause either.
        pause: "PauseNotSupported",
        configured: {
          step: "two",
          kept: true,
          autoStop: 20,
          autoArchive: 1440,
          autoDelete: 60,
          ttl: true,
          public: true,
        },
        autoPause: "AutoPauseNotSupported",
        resize: "SandboxResizeUnavailable",
        regionQuota: "RegionQuotaRunnerOnly",
        mounted: [
          ["/cache", true],
          ["/home/daytona/work", true],
        ],
        writable: "ok",
        initialized: true,
        afterInit: "init-ok",
        ancestors: true,
        legacyTelemetry: "TelemetryEndpointsDisabled",
        buildLogs: "SandboxHasNoBuildInfo",
        telemetry: true,
        cycle: ["stopped", "started"],
      });
    }).pipe(Effect.scoped),
    { tags, timeout: 300_000 },
  );
});

describe("CreateSandbox resources", () => {
  test(
    "resources on create fail with SandboxResourcesFromSnapshot",
    Effect.gen(function* () {
      expect(yield* get("/create-sandbox-resources")).toEqual({
        error: "SandboxResourcesFromSnapshot",
      });
    }),
    { tags, timeout: 120_000 },
  );
});

describe("CreateSandbox computer use", () => {
  // A desktop session bills like any running sandbox, and takes a while.
  test.skipIf(!!process.env.FAST)(
    "drives the desktop: input, windows, screenshots, recordings, accessibility, processes",
    Effect.gen(function* () {
      expect(yield* get("/computer-use")).toEqual({
        status: "active",
        system: "active",
        displays: 1,
        mouse: { x: 100, y: 120 },
        clicked: { x: 50, y: 60 },
        released: { x: 70, y: 80 },
        dragged: { x: 40, y: 40 },
        scrolled: true,
        screenshots: [true, true, true, true],
        recording: { stopped: "completed", listed: true, fetched: true, mp4: true, deleted: true },
        window: true,
        tree: true,
        node: "Show Desktop",
        focus: "AccessibilityActionNotSupported",
        setValue: "AccessibilityActionNotSupported",
        process: { running: true, logs: "string", errors: "string" },
        restarted: "novnc",
      });
    }),
    { tags, timeout: 300_000 },
  );
});

describe("ConnectSandbox", () => {
  test(
    "files: upload text and bytes, find, search, replace, download, move, chmod, delete",
    Effect.gen(function* () {
      expect(yield* get("/toolbox/files")).toEqual({
        listed: ["a.txt", "b.bin"],
        found: [{ file: "a.txt", line: 1 }],
        searched: ["a.txt"],
        text: "hello daytona\n",
        bytes: [0, 1, 2, 255],
        moved: { name: "c.txt", permissions: "0600" },
        gone: "gone",
      });
    }),
    { tags, timeout: 180_000 },
  );

  test(
    "processes: a stateful session, async logs, a code run, a resized PTY",
    Effect.gen(function* () {
      expect(yield* get("/toolbox/processes")).toEqual({
        echoed: "hi",
        asyncLogs: "done",
        listed: true,
        commands: 3,
        code: "42",
        pty: true,
        resized: { cols: 120, rows: 40 },
      });
    }),
    { tags, timeout: 180_000 },
  );

  test(
    "git: init, commit, branch, history, clone",
    Effect.gen(function* () {
      expect(yield* get("/toolbox/git")).toEqual({
        empty: "GitReferenceNotFound",
        status: { branch: "main", clean: true },
        hash: 40,
        branches: ["feature", "main"],
        current: "feature",
        history: ["first"],
        cloned: true,
      });
    }),
    { tags, timeout: 180_000 },
  );

  test(
    "git against an HTTP remote: config, push, clone, pull, restore, delete a branch, reset",
    Effect.gen(function* () {
      expect(yield* get("/toolbox/git-remote")).toEqual({
        config: "yes",
        remotes: ["origin"],
        pulled: ["one.txt", "two.txt"],
        restored: "one",
        createdOn: "scratch",
        branches: ["main"],
        history: ["one"],
      });
    }),
    { tags, timeout: 180_000 },
  );

  test(
    "session input, a session command, the entrypoint, daemon env, workspace symbols",
    Effect.gen(function* () {
      expect(yield* get("/toolbox/sessions")).toEqual({
        logs: "got:alchemy",
        command: "read line && echo got:$line",
        entrypoint: "entrypoint",
        entrypointLogs: "string",
        env: ["on", "off"],
        symbols: ["alchemyGreeting"],
      });
    }),
    { tags, timeout: 180_000 },
  );

  test(
    "streams over WebSockets: code runs, terminals, followed logs",
    Effect.gen(function* () {
      expect(yield* get("/toolbox/streams")).toEqual({
        run: { stdout: "hi\n", stderr: "err", error: "ZeroDivisionError" },
        chunks: "0\n1\n2\n",
        timedOut: "InterpreterTimeout",
        created: { output: true, exit: { exitCode: 3, reason: "non-zero exit" } },
        connected: { size: true, exit: { exitCode: 0 } },
        missing: "PtyConnectionRefused",
        followed: { stdout: "out1\nout2\nout3\n", stderr: "err1\nerr2\nerr3\n" },
        logs: { stdout: "out1\nout2\nout3\n", stderr: "err1\nerr2\nerr3\n" },
        entrypoint: true,
      });
    }),
    { tags, timeout: 180_000 },
  );

  test(
    "the handle vocabulary: exec, start, files and pty",
    Effect.gen(function* () {
      expect(yield* get("/toolbox/vocabulary")).toEqual({
        shell: { exitCode: 0, result: "hi from /tmp" },
        argv: "two words|it's|$HOME|",
        failed: 7,
        started: { stdout: "got:alchemy\n", stderr: "oops\n", exit: { exitCode: 3 } },
        files: {
          text: "alpha",
          bytes: [0, 255],
          listed: ["a.txt", "b.bin"],
          isDir: false,
          gone: "gone",
        },
        pty: { output: true, exit: { exitCode: 2, reason: "non-zero exit" } },
      });
    }),
    { tags, timeout: 180_000 },
  );

  test(
    "getTcpPort fetch: client request",
    Effect.gen(function* () {
      expect(yield* get("/toolbox/port-client")).toEqual({
        status: 201,
        header: "echo",
        received: {
          method: "POST",
          path: "/client/path",
          query: "a=1&b=two",
          header: "client",
          body: "hello from the client",
        },
        port: { port: 8091, url: true, token: true },
      });
    }),
    { tags, timeout: 180_000 },
  );

  test(
    "getTcpPort fetch: proxies a server request",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const client = yield* HttpClient.HttpClient;
      // The Worker forwards the request as it is, so the echo server sees
      // the Worker's own path and query.
      const response = yield* client
        .execute(
          HttpClientRequest.post(`${url}/proxy/echo/path?x=1&y=proxied`).pipe(
            HttpClientRequest.setHeader("X-Echo", "proxied"),
            HttpClientRequest.bodyText("hello through the Worker"),
          ),
        )
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (r) => r.status === 201,
            times: 15,
          }),
        );
      expect(response.status).toBe(201);
      expect(response.headers["x-sandbox"]).toBe("echo");
      expect(yield* response.json).toEqual({
        method: "POST",
        path: "/proxy/echo/path",
        query: "x=1&y=proxied",
        header: "proxied",
        body: "hello through the Worker",
      });
    }),
    { tags, timeout: 180_000 },
  );

  test(
    "bulk upload and download, with a per-path failure",
    Effect.gen(function* () {
      expect(yield* get("/toolbox/bulk")).toEqual({
        uploaded: [
          { path: "a.txt", bytes: 6 },
          { path: "nested/b.bin", bytes: 4 },
        ],
        files: [
          { path: "a.txt", content: "alpha\n" },
          { path: "nested/b.bin", content: [0, 1, 2, 255] },
        ],
        errors: [{ path: "missing.txt", code: "FILE_NOT_FOUND", statusCode: 404 }],
      });
    }),
    { tags, timeout: 180_000 },
  );

  test(
    "language server: symbols and completions for a TypeScript file",
    Effect.gen(function* () {
      expect(yield* get("/toolbox/lsp")).toEqual({ symbols: ["greet"], completes: true });
    }),
    { tags, timeout: 180_000 },
  );

  test(
    "interpreter contexts, listening ports, version, home and metrics",
    Effect.gen(function* () {
      expect(yield* get("/toolbox/system")).toMatchObject({
        context: "python",
        listed: true,
        inUse: true,
        ports: true,
        home: expect.stringMatching(/^\//),
        version: true,
        cpus: expect.any(Number),
        memory: true,
      });
    }),
    { tags, timeout: 180_000 },
  );

  test(
    "runs commands in the deployed sandbox and reads its preview URL",
    Effect.gen(function* () {
      const body = yield* get("/connect-sandbox");
      expect(body.uname.result.trim()).toEqual("Linux");
      expect(body.workDir.dir).toEqual(expect.any(String));
      expect(body.previewUrl).toMatch(/^https:\/\//);
      expect(body.identity).toEqual({
        id: "string",
        name: expect.stringContaining("bindingsdevbox"),
        toolbox: true,
      });
    }),
    { tags, timeout: 300_000 },
  );
});

describe("CreateVolume", () => {
  test(
    "gets or creates a volume by name, refuses names outside the prefix, deletes it",
    Effect.gen(function* () {
      const body = yield* get("/volume");
      expect(body).toEqual({
        same: true,
        state: "ready",
        rejected: "Daytona.NameOutsidePrefix",
        listed: true,
        deleted: true,
      });
    }),
    { tags, timeout: 180_000 },
  );
});

describe("CreateSecret", () => {
  test(
    "puts a secret twice into one secret, finds it, deletes it",
    Effect.gen(function* () {
      const body = yield* get("/secret");
      expect(body).toEqual({ same: true, placeholder: true, found: true, deleted: true });
    }),
    { tags, timeout: 120_000 },
  );
});

describe("CreateSnapshot", () => {
  test(
    "looks snapshots up by name and lists them",
    Effect.gen(function* () {
      const body = yield* get("/snapshot");
      expect(body).toEqual({ missing: true, listed: true });
    }),
    { tags, timeout: 120_000 },
  );
});

describe("ReadOrganization", () => {
  test(
    "reads regions, sandbox classes, quotas, GPU capacity and the webhook portal",
    Effect.gen(function* () {
      const body = yield* get("/organization");
      expect(body).toEqual({
        regions: expect.any(Number),
        classes: expect.any(Number),
        quota: expect.any(Number),
        gpus: expect.any(Number),
        webhooks: true,
        portal: "string",
      });
      expect(body.regions).toBeGreaterThan(0);
      expect(body.classes).toBeGreaterThan(0);
      expect(body.quota).toBeGreaterThan(0);
    }),
    { tags, timeout: 120_000 },
  );
});

describe("ReadUsage", () => {
  test(
    "reads aggregated, charted and per-sandbox usage",
    Effect.gen(function* () {
      expect(yield* get("/usage")).toEqual({
        total: true,
        chart: true,
        perSandbox: true,
        box: true,
      });
    }),
    { tags, timeout: 120_000 },
  );
});

describe("ReadAuditLogs", () => {
  test(
    "reads the audit log",
    Effect.gen(function* () {
      // Deploying the stack minted API keys, which the audit log records.
      const body = yield* get("/audit");
      expect(body.items).toBeGreaterThan(0);
      expect(body.scenarios).toBe(true);
    }),
    { tags, timeout: 120_000 },
  );
});
