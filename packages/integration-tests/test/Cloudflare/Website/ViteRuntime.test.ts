import * as NodeHttp from "node:http";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectResponse } from "../Utils/Http.ts";
import { expectWorkerExists, waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

// Runtime features of a `Website.Vite` Worker, mirroring
// `@cloudflare/vite-plugin`'s runtime playgrounds (see
// `vite-runtime-fixture/src/index.ts` for the playground behind each route).
// Each spec runs deployed and under `alchemy dev`, as the plugin runs each in
// build and dev mode; checks of local-only endpoints run in dev only.

const { test } = Test.make({ providers: Cloudflare.providers() });
const { test: devTest } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureDir = pathe.resolve(import.meta.dirname, "vite-runtime-fixture");
const containerFixtureDir = pathe.resolve(import.meta.dirname, "vite-container-runtime-fixture");
const partyserverFixtureDir = pathe.resolve(import.meta.dirname, "vite-partyserver-fixture");
const sensitiveFilesFixtureDir = pathe.resolve(import.meta.dirname, "vite-sensitive-files-fixture");
const SENSITIVE_FILES = [
  ".env",
  ".env.staging",
  ".dev.vars",
  ".dev.vars.staging",
  "worker-b/.env",
  "worker-b/.env.staging",
  "worker-b/.dev.vars",
  "worker-b/.dev.vars.staging",
  "alchemy.run.ts",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "client.key",
  "client.pfx",
  "client.p12",
  "client.p8",
  "client.jks",
  "custom-sensitive-file",
];
const nodeEnvFixtureDir = pathe.resolve(import.meta.dirname, "vite-node-env-fixture");
const additionalModulesFixtureDir = pathe.resolve(
  import.meta.dirname,
  "vite-additional-modules-fixture",
);
const moduleResolutionFixtureDir = pathe.resolve(
  import.meta.dirname,
  "vite-module-resolution-fixture",
);
const mainResolutionFixtureDir = pathe.resolve(import.meta.dirname, "vite-main-resolution-fixture");
const hotChannelFixtureDir = pathe.resolve(import.meta.dirname, "vite-hot-channel-fixture");

type Mode = "live" | "dev";

const deploySite = (stack: Test.ScratchStack, mode: Mode, options: { domain?: string } = {}) =>
  Effect.gen(function* () {
    const rootDir = yield* cloneFixture(fixtureDir, {
      prefix: "alchemy-vite-runtime-",
      tempRoot,
      entries: ["package.json", "vite.config.ts", "src", "worker-b"],
    });
    return yield* stack.deploy(
      Effect.gen(function* () {
        const workerB = yield* Cloudflare.Worker(`ViteRuntimeWorkerB${mode}`, {
          main: pathe.join(rootDir, "worker-b/index.ts"),
          compatibility: { date: "2026-03-17" },
          env: {
            COUNTER: Cloudflare.DurableObject("Counter", { className: "Counter" }),
            MY_WORKFLOW: Cloudflare.Workflow(`ViteRuntimeExternal${mode}`, {
              className: "MyWorkflow",
            }),
          },
        });
        return yield* Cloudflare.Website.Vite(`ViteRuntime${mode}`, {
          rootDir,
          main: "./src/index.ts",
          workersDev: true,
          compatibility: { date: "2026-03-17", flags: ["nodejs_compat"] },
          memo: { include: ["**/*"] },
          crons: ["* * * * *"],
          ...(options.domain ? { domain: options.domain } : {}),
          env: {
            KV: Cloudflare.KV.Namespace(`ViteRuntimeKv${mode}`),
            IMAGES: Cloudflare.Images.Images(),
            WAE: Cloudflare.AnalyticsEngine.Dataset("WAE", { dataset: "vite_runtime" }),
            RATE_LIMITER: Cloudflare.RateLimit("RATE_LIMITER", {
              namespaceId: 1001,
              simple: { limit: 1, period: 60 },
            }),
            COUNTERS: Cloudflare.DurableObject("Counter", { className: "Counter" }),
            LEGACY: Cloudflare.DurableObject("Legacy", { className: "Legacy" }),
            // Cloudflare no longer creates key-value backed namespaces, so
            // only the dev deploy declares one.
            ...(mode === "dev"
              ? {
                  KV_BACKED: Cloudflare.DurableObject("KvBacked", {
                    className: "KvBacked",
                    storage: "legacy-kv",
                  }),
                }
              : {}),
            INITIALIZED: Cloudflare.DurableObject("BlockConcurrency", {
              className: "BlockConcurrency",
            }),
            WEBSOCKET_SERVER: Cloudflare.DurableObject("WebSocketServer", {
              className: "WebSocketServer",
            }),
            MY_WORKFLOW: Cloudflare.Workflow(`ViteRuntimeWorkflow${mode}`, {
              className: "MyWorkflow",
            }),
            EXTERNAL_COUNTERS: Cloudflare.DurableObject("Counter", {
              className: "Counter",
              scriptName: workerB.workerName,
            }),
            EXTERNAL_WORKFLOW: Cloudflare.Workflow(`ViteRuntimeExternal${mode}`, {
              className: "MyWorkflow",
              scriptName: workerB.workerName,
            }),
            NAMED_ENTRYPOINT: Cloudflare.WorkerEntrypoint("NamedEntrypoint"),
            LEGACY_ENTRYPOINT: Cloudflare.WorkerEntrypoint("legacy"),
            STREAM: Cloudflare.Stream.Stream(),
            EMAIL: Cloudflare.Email.SendEmail("EMAIL", {
              allowedDestinationAddresses: ["recipient@example.com"],
            }),
            "importable-env_VAR": "my importable env variable",
            "importable-env_SECRET": Redacted.make("my importable env secret"),
          },
          ...(mode === "dev" ? { dev: { port: 0 } } : {}),
        });
      }),
    );
  });

const runtimeTests = (
  name: string,
  check: (url: string, mode: Mode) => Effect.Effect<void, unknown>,
  modes: ReadonlyArray<Mode> = ["live", "dev"],
) => {
  if (modes.includes("live")) {
    test.provider(
      name,
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          yield* stack.destroy();
          const site = yield* deploySite(stack, "live");
          yield* expectWorkerExists(site.workerName, accountId);
          yield* check(site.url!.replace(/\/$/, ""), "live");
          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(site.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["provider:cloudflare:worker", "live"], timeout: 360_000 },
    );
  }
  if (modes.includes("dev")) {
    devTest.provider(
      `${name} (dev)`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const site = yield* deploySite(stack, "dev");
          yield* check(site.url!.replace(/\/$/, ""), "dev");
        }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
      { tags: ["provider:cloudflare:worker", "local"], timeout: 180_000 },
    );
  }
};

const expectText = (url: string, expected: string, init?: RequestInit) =>
  expectResponse(
    url,
    (res) =>
      res.status === 200 && res.body === expected
        ? undefined
        : `body ${JSON.stringify(res.body.slice(0, 120))}, expected ${JSON.stringify(expected)}`,
    { label: `${url} → ${expected}`, ...(init?.headers ? { headers: init.headers as never } : {}) },
  );

const expectJson = (url: string, expected: unknown) =>
  expectResponse(
    url,
    (res) => {
      if (res.status !== 200) return `status ${res.status}`;
      try {
        expect(JSON.parse(res.body)).toEqual(expected);
        return undefined;
      } catch {
        return `json ${res.body.slice(0, 160)}`;
      }
    },
    { label: `${url} → ${JSON.stringify(expected)}` },
  );

// For calls that change state (increments): retries only a response that
// never reached the Worker (a Cloudflare HTML page while a fresh workers.dev
// URL propagates), so the Worker handles each call once.
const fetchText = (url: string, init?: RequestInit) =>
  Effect.tryPromise(async () => {
    const response = await fetch(url, init);
    const body = await response.text();
    if (/^\s*<(!DOCTYPE|html)/i.test(body))
      throw new Error(`not from the Worker: ${response.status}`);
    return { status: response.status, body };
  }).pipe(Effect.retry({ times: 10, schedule: Schedule.spaced("2 seconds") }));

const unique = () => crypto.randomUUID().slice(0, 8);

// `workflows` and `external-workflows`: create an instance, then poll until
// it completes with the playground's output.
const expectWorkflow = (url: string, prefix: string) =>
  Effect.gen(function* () {
    const id = `vite-runtime-${unique()}`;
    yield* expectResponse(`${url}${prefix}/create?id=${id}`, (res) =>
      res.status === 200 ? undefined : `status ${res.status}`,
    );
    yield* expectResponse(
      `${url}${prefix}/get?id=${id}`,
      (res) => {
        if (res.status !== 200) return `status ${res.status}`;
        const status = JSON.parse(res.body) as { status: string; output?: unknown };
        return status.status === "complete" && status.output === "Workflow output"
          ? undefined
          : `workflow ${res.body.slice(0, 160)}`;
      },
      { timeout: "120 seconds", label: `${prefix} completes` },
    );
  });

// `websockets`: a Durable Object answers string and ArrayBuffer messages.
const expectWebSocket = (url: string) =>
  Effect.tryPromise(
    () =>
      new Promise<Array<string>>((resolve, reject) => {
        const socket = new WebSocket(`${url.replace(/^http/, "ws")}/websocket`);
        const received: Array<string> = [];
        const timer = setTimeout(() => reject(new Error(`websocket: ${received}`)), 30_000);
        socket.addEventListener("open", () => socket.send("Client event"));
        socket.addEventListener("message", (event) => {
          received.push(String(event.data));
          if (received.length === 1) socket.send(new ArrayBuffer(10));
          if (received.length === 2) {
            clearTimeout(timer);
            socket.close();
            resolve(received);
          }
        });
        socket.addEventListener("error", () => reject(new Error("websocket error")));
      }),
  ).pipe(
    Effect.tap((received) =>
      Effect.sync(() =>
        expect(received).toEqual([
          "Durable Object received client message: 'Client event' of type 'string'.",
          "Durable Object received client message: '[object ArrayBuffer]' of type 'object'.",
        ]),
      ),
    ),
    Effect.retry({ times: 5, schedule: Schedule.spaced("3 seconds") }),
  );

describe.concurrent(
  "Vite runtime",
  { tags: ["provider:cloudflare", "provider:cloudflare:website"] },
  () => {
    // `bindings/__tests__/worker.spec.ts`
    runtimeTests(
      "Vite runtime: KV, Images, Analytics Engine and Rate Limiting bindings",
      (url, mode) =>
        Effect.gen(function* () {
          yield* expectText(`${url}/kv`, "KV binding works");
          yield* expectText(`${url}/images`, "Images binding works");
          yield* expectText(`${url}/ae`, "AE binding works");
          // The limit is per key, so a fresh key starts with a full quota.
          // Deployed, rate limiting is eventually consistent (counts are not
          // shared at once), so the second call is only checked in dev, where
          // the plugin's spec runs.
          const limited = yield* fetchText(`${url}/rate-limit?key=${unique()}`);
          expect(limited.body).toMatch(
            mode === "dev"
              ? /^Rate limit binding works: first: true, second: false$/
              : /^Rate limit binding works: first: true, second: (true|false)$/,
          );
        }),
    );

    // `durable-objects` and `block-concurrency-while`
    runtimeTests("Vite runtime: Durable Objects", (url, mode) =>
      Effect.gen(function* () {
        const name = `my-do-${unique()}`;
        yield* expectText(`${url}/do?name=${name}`, `Durable Object '${name}' count: 0`);
        for (const [path, count] of [
          ["/do/increment", 1],
          ["/do/increment", 2],
          ["/do/decrement", 1],
        ] as const) {
          expect((yield* fetchText(`${url}${path}?name=${name}`)).body).toBe(
            `Durable Object '${name}' count: ${count}`,
          );
        }
        yield* expectText(`${url}/do/legacy`, "Legacy Durable Object");
        yield* expectJson(`${url}/do/block-concurrency`, { isInitialized: true });
        if (mode === "dev") {
          yield* expectJson(`${url}/do/rpc-ordering?name=${unique()}`, { inOrder: true });
          yield* expectJson(`${url}/do/kv-backed`, { hasSql: false });
        }
        yield* expectWebSocket(url);
      }),
    );

    // A class declared `storage: "legacy-kv"` deploys with that backend, so a
    // new one reaches Cloudflare's own refusal (it no longer provisions
    // key-value backed namespaces) rather than silently becoming SQLite.
    test.provider(
      "Vite runtime: a new legacy-kv Durable Object reports Cloudflare's refusal",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-vite-runtime-kv-",
            tempRoot,
            entries: ["package.json", "worker-b"],
          });
          const exit = yield* stack
            .deploy(
              Cloudflare.Worker("ViteRuntimeKvBacked", {
                main: pathe.join(rootDir, "worker-b/index.ts"),
                compatibility: { date: "2026-03-17" },
                env: {
                  COUNTER: Cloudflare.DurableObject("Counter", {
                    className: "Counter",
                    storage: "legacy-kv",
                  }),
                },
              }),
            )
            .pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          expect(String(Cause.squash((exit as Exit.Failure<never, unknown>).cause))).toContain(
            "new namespaces must use storage: 'sqlite'",
          );
          yield* stack.destroy();
        }).pipe(logLevel),
      { tags: ["provider:cloudflare:worker", "live"], timeout: 360_000 },
    );

    // `external-durable-objects`
    runtimeTests("Vite runtime: a Durable Object defined in another Worker", (url) =>
      Effect.gen(function* () {
        const name = `my-do-${unique()}`;
        const body = (count: number) => `From worker-a: ${JSON.stringify({ name, count })}`;
        yield* expectText(`${url}/external-do?name=${name}`, body(0));
        expect((yield* fetchText(`${url}/external-do/increment?name=${name}`)).body).toBe(body(1));
        expect((yield* fetchText(`${url}/external-do/increment?name=${name}`)).body).toBe(body(2));
        yield* expectText(`${url}/external-do?name=${name}`, body(2));
      }),
    );

    // `workflows` and `external-workflows`
    runtimeTests("Vite runtime: Workflows, in this Worker and in another", (url) =>
      Effect.gen(function* () {
        yield* expectWorkflow(url, "/workflow");
        yield* expectWorkflow(url, "/external-workflow");
      }),
    );

    // `ctx-exports`, `same-worker-service-bindings`, `importable-env` and
    // `explicit-resource-management`
    runtimeTests("Vite runtime: entrypoints, the importable env and `using`", (url) =>
      Effect.gen(function* () {
        yield* expectText(
          `${url}/ctx-exports/worker-entrypoint`,
          "Hello World from a Worker Entrypoint",
        );
        yield* expectJson(`${url}/service/named`, { result: 20 });
        yield* expectText(`${url}/service/legacy`, "Legacy Worker entrypoint");
        const env = [
          { key: "importable-env_SECRET", value: "my importable env secret" },
          { key: "importable-env_VAR", value: "my importable env variable" },
        ];
        yield* expectResponse(`${url}/importable-env`, (res) => {
          const json = JSON.parse(res.body) as {
            importedAtModuleScope: string;
            handlerEnv: typeof env;
            importedEnv: typeof env;
          };
          const sorted = (entries: typeof env) =>
            [...entries].sort((a, b) => a.key.localeCompare(b.key));
          return json.importedAtModuleScope === "my importable env variable" &&
            JSON.stringify(sorted(json.handlerEnv)) === JSON.stringify(env) &&
            JSON.stringify(sorted(json.importedEnv)) === JSON.stringify(env)
            ? undefined
            : res.body.slice(0, 200);
        });
        yield* expectJson(`${url}/explicit-resource-management`, ["socket", "session"]);
      }),
    );

    // `cron-triggers` and `email-worker`: local trigger and email endpoints.
    runtimeTests(
      "Vite runtime: scheduled and email handlers via the local trigger endpoints",
      (url) =>
        Effect.gen(function* () {
          expect((yield* fetchText(`${url}/cdn-cgi/local/scheduled`)).body).toBe("ok");
          const email = yield* fetchText(
            `${url}/cdn-cgi/local/email?from=sender@example.com&to=recipient@example.com`,
            {
              method: "POST",
              body: [
                'From: "John" <sender@example.com>',
                "To: recipient@example.com",
                "Subject: Testing Email Workers Local Dev",
                "Date: Tue, 27 Aug 2024 08:49:44 -0700",
                "Message-ID: <6114391943504294873000@example.com>",
                "",
                "Hi there",
              ].join("\r\n"),
            },
          );
          expect(email.body).toBe("Worker successfully processed email");
          yield* expectJson(`${url}/handled`, {
            scheduled: "manual",
            email: "sender@example.com Hi there",
          });
          yield* expectText(`${url}/send`, "Email message sent successfully!");
        }),
      ["dev"],
    );

    // `cron-triggers/__tests__/cf-worker-header.spec.ts`: outbound fetches
    // carry `CF-Worker` with the Worker's first custom domain. Attaching a
    // domain deploys only to a zone the account owns, so this runs in dev.
    devTest.provider(
      "Vite runtime: outbound fetches carry the custom domain as CF-Worker (dev)",
      (stack) =>
        Effect.gen(function* () {
          const seen: Array<string | undefined> = [];
          const echo = NodeHttp.createServer((req, res) => {
            seen.push(req.headers["cf-worker"] as string | undefined);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ cfWorker: req.headers["cf-worker"] ?? null }));
          });
          yield* Effect.acquireRelease(
            Effect.promise(
              () => new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve)),
            ),
            () => Effect.promise(() => new Promise<void>((resolve) => echo.close(() => resolve()))),
          );
          const echoUrl = `http://127.0.0.1:${(echo.address() as { port: number }).port}/`;
          yield* stack.destroy();
          const site = yield* deploySite(stack, "dev", { domain: "vite-runtime.example.com" });
          const url = site.url!.replace(/\/$/, "");
          yield* expectJson(`${url}/cf-worker-header?echoUrl=${encodeURIComponent(echoUrl)}`, {
            cfWorker: "vite-runtime.example.com",
          });
        }).pipe(Effect.scoped, Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
      { tags: ["provider:cloudflare:worker", "local"], timeout: 180_000 },
    );

    // `hot-channel` (dev only): custom events between the dev server and
    // the Worker, from its module scope and its request scope.
    devTest.provider(
      "Vite runtime: custom events cross the Worker's hot channel (dev)",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const rootDir = yield* cloneFixture(hotChannelFixtureDir, {
            prefix: "alchemy-vite-hot-channel-",
            tempRoot,
            entries: ["package.json", "vite.config.ts", "src"],
          });
          const site = yield* stack.deploy(
            Cloudflare.Website.Vite("ViteHotChannel", {
              rootDir,
              main: "./src/index.ts",
              workersDev: true,
              compatibility: { date: "2026-03-17" },
              memo: { include: ["**/*"] },
              dev: { port: 0 },
            }),
          );
          yield* expectJson(site.url!, [
            "__server-event-data-received__",
            "__worker-module-event-data-received__",
            "__worker-request-event-data-received__",
          ]);
        }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
      { tags: ["provider:cloudflare:worker", "local"], timeout: 180_000 },
    );

    // `containers` (dev only, as the plugin's spec): Durable Objects drive
    // containers built from a local Dockerfile through `ctx.container`, one
    // as the class's own image and one as a named image.
    devTest.provider(
      "Vite runtime: containers built from a Dockerfile start and serve (dev)",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const rootDir = yield* cloneFixture(containerFixtureDir, {
            prefix: "alchemy-vite-container-runtime-",
            tempRoot,
            entries: ["package.json", "Dockerfile", "container", "src"],
          });
          const site = yield* stack.deploy(
            Cloudflare.Website.Vite("ViteContainerRuntime", {
              rootDir,
              main: "./src/index.ts",
              workersDev: true,
              compatibility: { date: "2026-03-17" },
              memo: { include: ["**/*"] },
              env: {
                DOCKERFILE: Cloudflare.Container("DockerfileContainer", {
                  className: "DockerfileContainer",
                  context: rootDir,
                  maxInstances: 2,
                }),
                NAMED_IMAGES: Cloudflare.DurableObject("NamedImagesContainer", {
                  className: "NamedImagesContainer",
                  containers: [
                    Cloudflare.Container("app", {
                      schedulingPolicy: "durable_object",
                      context: rootDir,
                    }),
                  ],
                }),
              },
              dev: { port: 0 },
            }),
          );
          const url = site.url!.replace(/\/$/, "");
          yield* expectJson(`${url}/named-images/images`, ["app"]);
          for (const prefix of ["/dockerfile", "/named-images"]) {
            yield* expectText(`${url}${prefix}/start`, "Container create request sent...");
            yield* expectText(`${url}${prefix}/status`, "true");
            yield* expectText(`${url}${prefix}/fetch`, "Hello World!");
          }
        }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
      {
        tags: ["provider:cloudflare:container", "provider:cloudflare:worker", "local"],
        timeout: 300_000,
      },
    );

    // `partyserver`: PartyServer routes a room's WebSocket to its Durable
    // Object, which answers the client's message (the playground's React
    // client, driven here over a raw WebSocket).
    for (const mode of ["live", "dev"] as const) {
      (mode === "live" ? test : devTest).provider(
        `Vite runtime: PartyServer rooms answer over WebSockets${mode === "dev" ? " (dev)" : ""}`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const rootDir = yield* cloneFixture(partyserverFixtureDir, {
              prefix: "alchemy-vite-partyserver-",
              tempRoot,
              entries: ["package.json", "index.html", "worker"],
            });
            const site = yield* stack.deploy(
              Cloudflare.Website.Vite(`VitePartyServer${mode}`, {
                rootDir,
                main: "./worker/index.ts",
                workersDev: true,
                compatibility: { date: "2024-12-30" },
                memo: { include: ["**/*"] },
                assets: { notFoundHandling: "single-page-application" },
                env: {
                  MyServer: Cloudflare.DurableObject("MyServer", { className: "MyServer" }),
                },
                ...(mode === "dev" ? { dev: { port: 0 } } : {}),
              }),
            );
            const url = site.url!.replace(/\/$/, "");
            yield* expectResponse(`${url}/`, (res) =>
              res.body.includes("Vite + PartyServer")
                ? undefined
                : `body ${res.body.slice(0, 120)}`,
            );
            const reply = yield* Effect.tryPromise(
              () =>
                new Promise<string>((resolve, reject) => {
                  const socket = new WebSocket(
                    `${url.replace(/^http/, "ws")}/parties/my-server/room1`,
                  );
                  const timer = setTimeout(() => reject(new Error("no reply")), 30_000);
                  socket.addEventListener("open", () => socket.send("Hello from the client!"));
                  socket.addEventListener("message", (event) => {
                    clearTimeout(timer);
                    socket.close();
                    resolve(String(event.data));
                  });
                  socket.addEventListener("error", () => reject(new Error("websocket error")));
                }),
            ).pipe(Effect.retry({ times: 5, schedule: Schedule.spaced("3 seconds") }));
            expect(reply).toBe("Message from the server: received 'Hello from the client!'");
          }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
        {
          tags: ["provider:cloudflare:worker", mode === "dev" ? "local" : "live"],
          timeout: 300_000,
        },
      );
    }

    // `sensitive-files`: the dev server refuses secrets, credentials and
    // the stack file (403), on top of a user's own `server.fs.deny`;
    // deployed, they were never assets, so the Worker answers.
    for (const mode of ["live", "dev"] as const) {
      (mode === "live" ? test : devTest).provider(
        `Vite runtime: sensitive files are never served${mode === "dev" ? " (dev)" : ""}`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const rootDir = yield* cloneFixture(sensitiveFilesFixtureDir, {
              prefix: "alchemy-vite-sensitive-files-",
              tempRoot,
              entries: [
                "package.json",
                "vite.config.ts",
                "src",
                "worker-b",
                ...SENSITIVE_FILES.filter((file) => !file.startsWith("worker-b/")),
              ],
            });
            const site = yield* stack.deploy(
              Cloudflare.Website.Vite(`ViteSensitiveFiles${mode}`, {
                rootDir,
                main: "./src/index.ts",
                workersDev: true,
                compatibility: { date: "2024-12-30" },
                memo: { include: ["**/*"] },
                ...(mode === "dev" ? { dev: { port: 0 } } : {}),
              }),
            );
            const url = site.url!.replace(/\/$/, "");
            yield* expectText(`${url}/`, "Worker A response");
            for (const file of SENSITIVE_FILES) {
              yield* expectResponse(
                `${url}/${file}`,
                (res) =>
                  mode === "dev"
                    ? res.status === 403
                      ? undefined
                      : `status ${res.status}: ${res.body.slice(0, 80)}`
                    : res.body === "Worker A response"
                      ? undefined
                      : `body ${res.body.slice(0, 80)}`,
                { label: `/${file}` },
              );
            }
          }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
        {
          tags: ["provider:cloudflare:worker", mode === "dev" ? "local" : "live"],
          timeout: 300_000,
        },
      );
    }

    // `node-env`: Vite replaces `process.env.NODE_ENV` in the Worker, with
    // and without `nodejs_compat`; the build drops React's development code.
    for (const mode of ["live", "dev"] as const) {
      for (const nodejsCompat of [false, true]) {
        const label = `${nodejsCompat ? " with nodejs_compat" : ""}${mode === "dev" ? " (dev)" : ""}`;
        (mode === "live" ? test : devTest).provider(
          `Vite runtime: process.env.NODE_ENV is replaced${label}`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const rootDir = yield* cloneFixture(nodeEnvFixtureDir, {
                prefix: "alchemy-vite-node-env-",
                tempRoot,
                entries: ["package.json", "src"],
              });
              const site = yield* stack.deploy(
                Cloudflare.Website.Vite(`ViteNodeEnv${mode}${nodejsCompat ? "Compat" : ""}`, {
                  rootDir,
                  main: "./src/index.ts",
                  workersDev: true,
                  compatibility: {
                    date: "2024-12-30",
                    ...(nodejsCompat ? { flags: ["nodejs_compat"] } : {}),
                  },
                  memo: { include: ["**/*"] },
                  ...(mode === "dev" ? { dev: { port: 0 } } : {}),
                }),
              );
              const nodeEnv = mode === "dev" ? "development" : "production";
              yield* expectResponse(site.url!, (res) =>
                res.body.includes("<h1>Server Side React</h1>") &&
                res.body.includes(`The value of process.env.NODE_ENV is &quot;${nodeEnv}&quot;`)
                  ? undefined
                  : `body ${res.body.slice(0, 200)}`,
              );
              if (mode === "live") {
                const fs = yield* FileSystem.FileSystem;
                const files = yield* fs.readDirectory(rootDir, { recursive: true });
                const bundles = files.filter(
                  (file) =>
                    /\.m?js$/.test(file) &&
                    !file.startsWith("src") &&
                    !file.includes("node_modules"),
                );
                expect(bundles.length).toBeGreaterThan(0);
                for (const file of bundles) {
                  const code = yield* fs.readFileString(pathe.join(rootDir, file));
                  expect(code).not.toContain("react-dom.development.js");
                  expect(code).not.toContain("https://github.com/facebook/react");
                }
              }
            }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
          {
            tags: ["provider:cloudflare:worker", mode === "dev" ? "local" : "live"],
            timeout: 300_000,
          },
        );
      }
    }

    // `additional-modules`: Data, Text and CompiledWasm modules by extension,
    // through subpath imports, and on `new_module_registry` (dev, as the
    // playground runs it).
    for (const [mode, newModuleRegistry] of [
      ["live", false],
      ["dev", false],
      ["dev", true],
    ] as const) {
      const label = `${newModuleRegistry ? " on new_module_registry" : ""}${mode === "dev" ? " (dev)" : ""}`;
      (mode === "live" ? test : devTest).provider(
        `Vite runtime: additional modules load${label}`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const rootDir = yield* cloneFixture(additionalModulesFixtureDir, {
              prefix: "alchemy-vite-additional-modules-",
              tempRoot,
              entries: ["package.json", "src"],
            });
            const site = yield* stack.deploy(
              Cloudflare.Website.Vite(
                `ViteAdditionalModules${mode}${newModuleRegistry ? "Registry" : ""}`,
                {
                  rootDir,
                  main: "./src/index.ts",
                  workersDev: true,
                  compatibility: {
                    date: "2024-12-30",
                    ...(newModuleRegistry ? { flags: ["new_module_registry"] } : {}),
                  },
                  memo: { include: ["**/*"] },
                  ...(mode === "dev" ? { dev: { port: 0 } } : {}),
                },
              ),
            );
            const url = site.url!.replace(/\/$/, "");
            const hello = (res: { body: string }) =>
              res.body.includes("<h1>Hello world</h1>")
                ? undefined
                : `body ${res.body.slice(0, 120)}`;
            yield* expectJson(`${url}/bin`, { byteLength: 342936 });
            yield* expectResponse(`${url}/html`, hello);
            yield* expectResponse(`${url}/subpath-html`, hello);
            yield* expectResponse(`${url}/subpath-html-with-ext`, hello);
            yield* expectText(`${url}/text`, "Example text content.\n");
            yield* expectText(`${url}/sql`, "SELECT * FROM users;\n");
            yield* expectText(`${url}/text2`, "Example text content 2");
            yield* expectJson(`${url}/wasm`, { result: 7 });
            yield* expectJson(`${url}/wasm-with-module-param`, { result: 11 });
            yield* expectJson(`${url}/wasm-with-init-param`, { result: 15 });
          }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
        {
          tags: ["provider:cloudflare:worker", mode === "dev" ? "local" : "live"],
          timeout: 300_000,
        },
      );
    }

    // `module-resolution`: CommonJS `require` with and without extensions
    // and of JSON, `cloudflare:*` imports from the Worker and from a package,
    // a user alias, and an optimizeDeps-excluded package importing a virtual
    // module, with and without `nodejs_compat`.
    for (const mode of ["live", "dev"] as const) {
      for (const nodejsCompat of [false, true]) {
        const label = `${nodejsCompat ? " with nodejs_compat" : ""}${mode === "dev" ? " (dev)" : ""}`;
        (mode === "live" ? test : devTest).provider(
          `Vite runtime: modules resolve like the plugin${label}`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const rootDir = yield* cloneFixture(moduleResolutionFixtureDir, {
                prefix: "alchemy-vite-module-resolution-",
                tempRoot,
                entries: ["package.json", "vite.config.ts", "src", "packages"],
              });
              // The playground's `file:` dependencies, installed as pnpm
              // installs them: copied into `node_modules`.
              const fs = yield* FileSystem.FileSystem;
              for (const name of ["excludes", "imports", "requires"]) {
                yield* fs.copy(
                  pathe.join(rootDir, "packages", name),
                  pathe.join(rootDir, `node_modules/@playground/module-resolution-${name}`),
                );
              }
              const site = yield* stack.deploy(
                Cloudflare.Website.Vite(
                  `ViteModuleResolution${mode}${nodejsCompat ? "Compat" : ""}`,
                  {
                    rootDir,
                    main: "./src/index.ts",
                    workersDev: true,
                    compatibility: {
                      date: "2024-12-30",
                      ...(nodejsCompat ? { flags: ["nodejs_compat"] } : {}),
                    },
                    memo: { include: ["**/*"] },
                    ...(mode === "dev" ? { dev: { port: 0 } } : {}),
                  },
                ),
              );
              const url = site.url!.replace(/\/$/, "");
              yield* expectJson(`${url}/require-ext`, {
                "(requires/ext) hello.cjs (wrong-extension)": null,
                "(requires/ext) helloWorld": "hello (.js) world (.cjs)",
                "(requires/ext) world.js (wrong-extension)": null,
              });
              yield* expectJson(`${url}/require-no-ext`, {
                "(requires/no-ext) helloWorld": "hello (.js) world (.cjs)",
              });
              yield* expectJson(`${url}/require-json`, {
                "(requires/json) package name": "@playground/module-resolution-requires",
                "(requires/json) package version": "1.0.0",
              });
              // workerd names the built class `DurableObjectBase` (a workerd
              // quirk the playground notes for builds).
              const durableObjectName = (res: { status: number; body: string }) => {
                if (res.status !== 200) return `status ${res.status}`;
                const body = JSON.parse(res.body) as Record<string, string>;
                return Object.entries(body).every(([key, value]) =>
                  key.includes("DurableObject.name") ? /^DurableObject(Base)?$/.test(value) : true,
                )
                  ? undefined
                  : `body ${res.body}`;
              };
              yield* expectResponse(`${url}/cloudflare-imports`, (res) => {
                const mismatch = durableObjectName(res);
                if (mismatch) return mismatch;
                const body = JSON.parse(res.body) as Record<string, string>;
                return body["(cloudflare:workers) WorkerEntrypoint.name"] === "WorkerEntrypoint" &&
                  body["(cloudflare:sockets) typeof connect"] === "function"
                  ? undefined
                  : `body ${res.body}`;
              });
              yield* expectResponse(`${url}/external-cloudflare-imports`, (res) => {
                const mismatch = durableObjectName(res);
                if (mismatch) return mismatch;
                return "(EXTERNAL) (cloudflare:workers) DurableObject.name" in JSON.parse(res.body)
                  ? undefined
                  : `body ${res.body}`;
              });
              yield* expectText(`${url}/@alias/test`, "OK!");
              yield* expectText(`${url}/optimize-deps/exclude`, "Export from virtual module");
            }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
          {
            tags: ["provider:cloudflare:worker", mode === "dev" ? "local" : "live"],
            timeout: 300_000,
          },
        );
      }
    }

    // `main-resolution`: `main` as a path (with a custom entry file
    // extension), a package export, and a virtual module.
    for (const mode of ["live", "dev"] as const) {
      for (const variant of [
        { config: "default", main: "./src/index.ts", flags: [] },
        {
          config: "package-export-main",
          main: "@playground/main-resolution-package/entry",
          flags: ["nodejs_compat"],
        },
        { config: "virtual-module-main", main: "virtual:entry", flags: [] },
      ]) {
        (mode === "live" ? test : devTest).provider(
          `Vite runtime: main resolves as ${variant.config}${mode === "dev" ? " (dev)" : ""}`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const rootDir = yield* cloneFixture(mainResolutionFixtureDir, {
                prefix: "alchemy-vite-main-resolution-",
                tempRoot,
                entries: ["package.json", "configs", "src", "package"],
              });
              const fs = yield* FileSystem.FileSystem;
              yield* fs.copyFile(
                pathe.join(rootDir, `configs/${variant.config}.ts`),
                pathe.join(rootDir, "vite.config.ts"),
              );
              // The playground's `file:` dependency, copied in as pnpm does.
              yield* fs.copy(
                pathe.join(rootDir, "package"),
                pathe.join(rootDir, "node_modules/@playground/main-resolution-package"),
              );
              const site = yield* stack.deploy(
                Cloudflare.Website.Vite(`ViteMainResolution${mode}${variant.config}`, {
                  rootDir,
                  main: variant.main,
                  workersDev: true,
                  compatibility: { date: "2024-12-30", flags: variant.flags },
                  memo: { include: ["**/*"] },
                  ...(mode === "dev" ? { dev: { port: 0 } } : {}),
                }),
              );
              if (variant.config === "default") {
                yield* expectJson(site.url!, {
                  entry: "Root config",
                  imported: "Root config import",
                });
              } else {
                yield* expectText(
                  site.url!,
                  variant.config === "package-export-main"
                    ? "Package export as Worker entry file"
                    : "Virtual module as Worker entry file",
                );
              }
            }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
          {
            tags: ["provider:cloudflare:worker", mode === "dev" ? "local" : "live"],
            timeout: 300_000,
          },
        );
      }
    }

    // Miniflare's outbound `cf.image` mock (dev only: deployed, `cf.image`
    // needs a zone with Image Transformations, which workers.dev lacks).
    devTest.provider(
      "Vite runtime: cf.image fetches are resized locally (dev)",
      (stack) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          // An 8x4 PNG, generated once with Sharp.
          const png = yield* fs.readFile(pathe.join(fixtureDir, "cf-image-source.png"));
          const origin = NodeHttp.createServer((_req, res) => {
            res.setHeader("content-type", "image/png");
            res.end(png);
          });
          yield* Effect.acquireRelease(
            Effect.promise(
              () => new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve)),
            ),
            () =>
              Effect.promise(() => new Promise<void>((resolve) => origin.close(() => resolve()))),
          );
          const imageUrl = `http://127.0.0.1:${(origin.address() as { port: number }).port}/a.png`;
          yield* stack.destroy();
          const site = yield* deploySite(stack, "dev");
          const response = yield* Effect.promise(() =>
            fetch(
              `${site.url!.replace(/\/$/, "")}/cf-image?imageUrl=${encodeURIComponent(imageUrl)}`,
            ),
          );
          const body = Buffer.from(yield* Effect.promise(() => response.arrayBuffer()));
          // A PNG's IHDR chunk holds its width and height at bytes 16-23.
          expect({
            resized: response.headers.get("cf-resized"),
            size: [body.readUInt32BE(16), body.readUInt32BE(20)],
          }).toEqual({ resized: "internal=ok/m", size: [4, 2] });
        }).pipe(Effect.scoped, Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
      { tags: ["provider:cloudflare:worker", "local"], timeout: 180_000 },
    );

    // `stream-binding`: the preview URL is on the dev server's own origin
    // (the port it actually bound) under `/__cf_local/stream`.
    runtimeTests(
      "Vite runtime: Stream uploads return a local preview URL",
      (url) =>
        Effect.gen(function* () {
          const upload = yield* fetchText(`${url}/stream/upload`);
          const { preview, id } = JSON.parse(upload.body) as { preview: string; id: string };
          expect(id).toBeTruthy();
          expect(preview).toBe(`${new URL(url).origin}/__cf_local/stream/${id}/watch`);
          const video = yield* fetchText(preview);
          expect(video.status).toBe(200);
        }),
      ["dev"],
    );
  },
);
