/**
 * Vercel Function dev-mode (`alchemy dev`) tests — the local provider per
 * the Local-tests doctrine: `dev: true` runs local providers behind the
 * RPC sidecar proxy by default, matching the process topology of the real
 * `alchemy dev` command.
 *
 * Covers (a) the local roundtrip across the FULL launcher matrix
 * (`{ fetch }`, method exports, `(req, res)`, and the Effect bridge) with
 * `dev:` identity markers, injected platform env/headers, the guarded cron
 * route, and URL stability across a config restart; and (b) the
 * `Alchemy.remote()` opt-out deploying live during dev with out-of-band
 * distilled verification and post-destroy absence.
 */
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { MinimumLogLevel } from "effect/References";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import LocalEffectFn from "./fixtures/local-effect-fn.ts";

const { test } = Test.make({
  providers: Vercel.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const asyncMain = new URL("./fixtures/local-async-fn.ts", import.meta.url)
  .pathname;
const methodMain = new URL("./fixtures/local-method-fn.ts", import.meta.url)
  .pathname;
const nodeMain = new URL("./fixtures/local-node-fn.ts", import.meta.url)
  .pathname;

class NotReady extends Data.TaggedError("NotReady")<{
  status: number;
  location: string | undefined;
  message: string;
}> {}

// The first request races the dev bundle's first build (rolldown over the
// alchemy barrel for Effect functions) — retry with a bounded cap.
const readiness = Schedule.max([
  Schedule.min([
    Schedule.exponential("500 millis"),
    Schedule.spaced("2 seconds"),
  ]),
  Schedule.recurs(45),
]);

const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(
              new NotReady({
                status: res.status,
                location: res.headers.location,
                message: `GET ${url} -> ${res.status}${
                  res.headers.location === undefined
                    ? ""
                    : ` (location: ${res.headers.location})`
                }`,
              }),
            ),
      ),
      Effect.retry({
        while: (e): e is NotReady => e instanceof NotReady,
        schedule: readiness,
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

const getStatus = (url: string, headers?: Record<string, string>) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.get(url);
    if (headers) request = HttpClientRequest.setHeaders(request, headers);
    return yield* client.execute(request);
  });

test.provider(
  "local roundtrip: launcher matrix, dev markers, cron guard, hot restart",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const client = yield* HttpClient.HttpClient;

      const deploy = (greeting: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const asyncFn = yield* Vercel.Function("AsyncFn", {
              main: asyncMain,
              env: { GREETING: greeting, SELF_URL: Vercel.Function.URL },
            });
            const methodFn = yield* Vercel.Function("MethodFn", {
              main: methodMain,
            });
            const nodeFn = yield* Vercel.Function("NodeFn", {
              main: nodeMain,
            });
            const effectFn = yield* LocalEffectFn;
            return { asyncFn, methodFn, nodeFn, effectFn };
          }),
        );

      const first = yield* deploy("hello");

      // dev identity markers — proof no cloud call ran.
      for (const fn of [
        first.asyncFn,
        first.methodFn,
        first.nodeFn,
        first.effectFn,
      ]) {
        expect(fn.url).toMatch(/^http:\/\/localhost:\d+$/);
        expect(fn.projectId).toMatch(/^dev:/);
        expect(fn.deploymentId).toMatch(/^dev:/);
      }

      // ── arm 1: default { fetch } + injected platform env + self URL.
      const env = (yield* getJsonReady(`${first.asyncFn.url}/env`)) as {
        greeting: string | null;
        vercel: string | null;
        vercelEnv: string | null;
        vercelUrl: string | null;
        deploymentId: string | null;
        selfUrl: string | null;
      };
      expect(env.greeting).toBe("hello");
      expect(env.vercel).toBe("1");
      expect(env.vercelEnv).toBe("development");
      expect(`http://${env.vercelUrl}`).toBe(first.asyncFn.url);
      expect(env.deploymentId).toMatch(/^dev:/);
      expect(env.selfUrl).toBe(first.asyncFn.url);

      // Injected platform headers.
      const headers = (yield* getJsonReady(`${first.asyncFn.url}/headers`)) as {
        vercelId: string | null;
        country: string | null;
        proto: string | null;
      };
      expect(headers.vercelId).toBeTruthy();
      expect(headers.country).toBe("US");
      expect(headers.proto).toBe("http");

      // Request body streaming (POST /echo).
      const echoRes = yield* client.execute(
        HttpClientRequest.post(`${first.asyncFn.url}/echo`).pipe(
          HttpClientRequest.bodyText("ping", "text/plain"),
        ),
      );
      expect(echoRes.status).toBe(200);
      expect((yield* echoRes.json) as object).toEqual({ echo: "ping" });

      // ── arm 3: method exports (GET/POST routed, DELETE is 405 + Allow).
      const got = (yield* getJsonReady(`${first.methodFn.url}/route`)) as {
        method: string;
        path: string;
      };
      expect(got).toEqual({ method: "GET", path: "/route" });
      const posted = yield* client.execute(
        HttpClientRequest.post(`${first.methodFn.url}/route`).pipe(
          HttpClientRequest.bodyText("body", "text/plain"),
        ),
      );
      expect((yield* posted.json) as object).toEqual({
        method: "POST",
        echo: "body",
      });
      const del = yield* client.execute(
        HttpClientRequest.make("DELETE")(`${first.methodFn.url}/route`),
      );
      expect(del.status).toBe(405);

      // ── arm 2: legacy (req, res) default export.
      const node = (yield* getJsonReady(`${first.nodeFn.url}/anything`)) as {
        node: boolean;
        url: string | null;
      };
      expect(node.node).toBe(true);
      expect(node.url).toBe("/anything");

      // ── Effect bridge: served through makeVercelBridge inside the shim.
      const effectEnv = (yield* getJsonReady(`${first.effectFn.url}/env`)) as {
        vercelEnv: string | null;
        deploymentId: string | null;
      };
      expect(effectEnv.vercelEnv).toBe("development");
      expect(effectEnv.deploymentId).toMatch(/^dev:/);

      // Cron route guard: unauthorized is a 401; the platform invoker's
      // exact shape (Bearer CRON_SECRET) runs the handler.
      expect(first.effectFn.cronSecret).toBeDefined();
      const secret = Redacted.value(first.effectFn.cronSecret!);
      const unauthorized = yield* getStatus(
        `${first.effectFn.url}/_alchemy/cron/0`,
      );
      expect(unauthorized.status).toBe(401);
      const fired = yield* getStatus(`${first.effectFn.url}/_alchemy/cron/0`, {
        authorization: `Bearer ${secret}`,
        "user-agent": "vercel-cron/1.0",
      });
      expect(fired.status).toBe(200);
      const cronFires = (yield* getJsonReady(
        `${first.effectFn.url}/cron-fires`,
      )) as { cronFires: number };
      expect(cronFires.cronFires).toBe(1);

      // ── Hot restart on config (env) change keeps the URL stable.
      const second = yield* deploy("bonjour");
      expect(second.asyncFn.url).toBe(first.asyncFn.url);
      expect(second.asyncFn.deploymentId).not.toBe(first.asyncFn.deploymentId);
      const updated = yield* Effect.gen(function* () {
        const body = (yield* getJsonReady(`${second.asyncFn.url}/env`)) as {
          greeting: string | null;
        };
        return body.greeting;
      }).pipe(
        // The restart cuts over make-before-break: the old child may serve
        // a few more requests until the replacement is ready.
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (greeting) => greeting === "bonjour",
          times: 60,
        }),
      );
      expect(updated).toBe("bonjour");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "Alchemy.remote() Function deploys live during dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* Vercel.Function("RemoteFn", {
            main: asyncMain,
            env: { GREETING: "live" },
          }).pipe(Alchemy.remote());
          return { fn };
        }),
      );

      // Real cloud identity — not the local emulator.
      expect(deployed.fn.projectId).not.toMatch(/^dev:/);
      expect(deployed.fn.url).toMatch(/^https:\/\//);

      // Round-trip against the real deployment.
      const env = (yield* getJsonReady(`${deployed.fn.url}/env`)) as {
        greeting: string | null;
        vercelEnv: string | null;
      };
      expect(env.greeting).toBe("live");
      expect(env.vercelEnv).toBe("production");

      // Out-of-band via distilled: the project exists on real Vercel.
      const { teamId } = yield* Vercel.VercelEnvironment.current;
      const project = yield* projects.getProject({
        idOrName: deployed.fn.projectId,
        teamId,
      });
      expect(project.id).toBe(deployed.fn.projectId);

      yield* stack.destroy();

      // The live project was deleted from the cloud on destroy (the state
      // row is stamped live, so the live provider handles the delete even
      // in a dev run).
      const gone = yield* projects
        .getProject({ idOrName: deployed.fn.projectId, teamId })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (g) => g,
            times: 10,
          }),
        );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
