/**
 * Local.Service lifecycle against a REAL detached process: deploy
 * spawns `bun <main>` and records the pid; the Effectful runtime binds
 * an ephemeral port and reports it back through the startup handshake;
 * a second deploy converges (same pid — no needless restart); destroy
 * stops the process, idempotently.
 */
import * as Alchemy from "@/index.ts";
import * as Local from "@/Local/index.ts";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import TestApi from "./fixtures/effect-service.ts";

const { test, deploy, destroy } = Test.make({
  providers: Local.providers(),
});

/** Ask the OS for a free ephemeral port. */
const freePort: Effect.Effect<number> = Effect.promise(
  () =>
    new Promise<number>((resolve) => {
      void import("node:net").then((net) => {
        const server = net.createServer();
        server.listen(0, () => {
          const port = (server.address() as { port: number }).port;
          server.close(() => resolve(port));
        });
      });
    }),
);

const isAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

const untilDead = (pid: number) =>
  isAlive(pid).pipe(
    Effect.map((alive) => !alive),
    Effect.repeat({
      schedule: Schedule.spaced("100 millis"),
      until: (done) => done,
      times: 50,
    }),
  );

test(
  "an Effectful Constructor serves fetch from a detached process",
  Effect.gen(function* () {
    // the stack is built HERE so every attempt gets fresh state; no
    // port anywhere — the runtime binds an ephemeral one and reports
    // it back through the startup handshake
    const EffectStack = Alchemy.Stack(
      "ServerEffectServiceTest",
      { providers: Local.providers(), state: inMemoryState() },
      Effect.gen(function* () {
        const api = yield* TestApi;
        return {
          url: api.url.as<string | undefined>(),
          pid: api.pid.as<number>(),
        };
      }),
    );

    const out = yield* deploy(EffectStack);
    const pid = yield* Effect.gen(function* () {
      // the handshake observed the bound port and reflected it as url
      expect(out.url).toMatch(/^http:\/\/localhost:\d+$/);

      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(`${out.url}/hello`).pipe(
        Effect.retry({
          schedule: Schedule.exponential("200 millis"),
          times: 12,
        }),
      );
      expect(response.status).toBe(200);
      const body = (yield* response.json) as {
        ok: boolean;
        stack: string;
      };
      expect(body.ok).toBe(true);
      // the process knows its stack identity (ALCHEMY_STACK_NAME env)
      expect(body.stack).toBe("ServerEffectServiceTest");
      return out.pid;
    }).pipe(Effect.ensuring(Effect.orDie(destroy(EffectStack))));

    expect(yield* untilDead(pid)).toBe(true);
  }),
  { timeout: 60_000 },
);

test(
  "spawns detached, converges on redeploy, dies on destroy",
  Effect.gen(function* () {
    const port = yield* freePort;
    const TestStack = Alchemy.Stack(
      "ServerServiceTest",
      { providers: Local.providers(), state: inMemoryState() },
      Effect.gen(function* () {
        const service = yield* Local.Service("TestService", {
          main: new URL("./fixtures/service-main.ts", import.meta.url).pathname,
          port,
          env: { MARKER: "one" },
          // skip source hashing: convergence is asserted via the deploy hash
          memo: false,
        });
        return {
          url: service.url.as<string | undefined>(),
          pid: service.pid.as<number>(),
        };
      }),
    );

    const first = yield* deploy(TestStack);
    yield* Effect.gen(function* () {
      expect(first.url).toBe(`http://localhost:${port}`);
      expect(yield* isAlive(first.pid)).toBe(true);

      // the service actually serves — retry through process startup
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(`${first.url}/`).pipe(
        Effect.retry({
          schedule: Schedule.exponential("100 millis"),
          times: 10,
        }),
      );
      expect(response.status).toBe(200);
      expect(yield* response.text).toBe("ok:one");

      // convergence: same command + env + live pid ⇒ NO restart
      const second = yield* deploy(TestStack);
      expect(second.pid).toBe(first.pid);
      expect(yield* isAlive(first.pid)).toBe(true);
    }).pipe(Effect.ensuring(Effect.orDie(destroy(TestStack))));

    // destroy stopped the process (bounded wait for the TERM to land)
    expect(yield* untilDead(first.pid)).toBe(true);
  }),
  { timeout: 60_000 },
);
