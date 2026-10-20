import * as NodeHttp from "node:http";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
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
  Effect.promise(
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
        }
        yield* expectWebSocket(url);
      }),
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
