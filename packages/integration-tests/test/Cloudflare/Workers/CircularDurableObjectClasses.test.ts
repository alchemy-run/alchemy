import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { Action } from "alchemy/Action";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const aMain = pathe.resolve(import.meta.dirname, "fixtures/circular-do-classes/a.ts");
const bMain = pathe.resolve(import.meta.dirname, "fixtures/circular-do-classes/b.ts");

/**
 * Holds B's update back on the second deploy. B waits for it (a non-cycle
 * upstream) while its cycle peer A goes ahead against B's previous output,
 * so A's upload deterministically reaches Cloudflare before B exports the
 * class A now binds — longer than any bounded not-found retry rides out.
 */
const Gate = Action(
  "CircularDoGate",
  Effect.fn(function* (input: { version: number }) {
    if (input.version > 1) yield* Effect.sleep("40 seconds");
    return { value: `v${input.version}` };
  }),
);

/**
 * A and B bind each other (#3103): B binds A as a service, A binds B's
 * Durable Object classes by `scriptName`. Version 2 adds `Second` to B and
 * binds it from A in the same deploy.
 */
const program = (version: 1 | 2) =>
  Effect.gen(function* () {
    const gate = yield* Gate({ version });
    const classes = version === 1 ? ["First"] : ["First", "Second"];

    const B = Cloudflare.Worker("CircularDoHost", {
      main: bMain,
      env: {
        GATE: gate.value,
        A: Effect.suspend((): Effect.Effect<Cloudflare.Worker, never, Cloudflare.Providers> => A),
        ...Object.fromEntries(classes.map((name) => [name, Cloudflare.DurableObject(name)])),
      },
    });

    const A = Cloudflare.Worker("CircularDoCaller", {
      main: aMain,
      env: Object.fromEntries(
        classes.map((name) => [
          name,
          Effect.map(B, (b) => Cloudflare.DurableObject(name, { scriptName: b.workerName })),
        ]),
      ),
    });

    const a = yield* A;
    const b = yield* B;
    return { url: a.url.as<string>(), workerNames: [a.workerName, b.workerName] };
  });

const fetchClass = Effect.fn(function* (url: string, cls: string) {
  const client = yield* HttpClient.HttpClient;
  return yield* client
    .execute(
      HttpClientRequest.get(`${url}/?cls=${cls}`).pipe(
        HttpClientRequest.setHeader("connection", "close"),
      ),
    )
    .pipe(
      Effect.flatMap((res) => Effect.map(res.text, (body) => `${res.status} ${body}`)),
      Effect.filterOrFail(
        (body) => body === `200 ${cls}`,
        (body) => new Error(`expected ${cls}, got ${body.slice(0, 300)}`),
      ),
      Effect.map(() => cls),
      Effect.retry({
        schedule: Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("5 seconds")]),
        times: 10,
      }),
    );
});

test.provider(
  "a cycle member binding a class its peer adds in the same deploy waits for the peer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const v1 = yield* stack.deploy(program(1));
      expect(yield* fetchClass(v1.url, "First")).toBe("First");

      // The second deploy updates both Workers in place: B adds `Second`,
      // A binds it.
      const plan = yield* stack.plan(program(2));
      const actionOf = (logicalId: string) =>
        (Object.values(plan.resources) as any[]).find(
          (node) => node.resource.LogicalId === logicalId,
        )?.action;
      expect(actionOf("CircularDoHost")).toBe("update");
      expect(actionOf("CircularDoCaller")).toBe("update");

      // B's update waits on the gate; A must not fail its upload on the
      // `Second` class B hasn't exported yet.
      const v2 = yield* stack.deploy(program(2));
      expect(yield* fetchClass(v2.url, "Second")).toBe("Second");
      expect(yield* fetchClass(v2.url, "First")).toBe("First");

      yield* stack.destroy();

      const { accountId } = yield* yield* CloudflareEnvironment;
      for (const scriptName of v2.workerNames) {
        const gone = yield* workers.getScript({ accountId, scriptName }).pipe(
          Effect.as(false),
          Effect.catchTag("WorkerNotFound", () => Effect.succeed(true)),
          Effect.repeat({
            while: (gone) => !gone,
            schedule: Schedule.spaced("1 second"),
            times: 8,
          }),
        );
        expect(gone).toBe(true);
      }
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 300_000,
  },
);
