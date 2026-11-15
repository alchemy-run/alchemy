import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import * as RivetDocker from "@alchemy.run/rivet/Docker";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { ensureDockerSwarm } from "../Docker/Runtime.ts";
import NodeEcho from "./fixtures/node-echo.ts";

const CONTROL_PLANE_PORT = 16470;
const POOL = "node-test";

const testOptions = { providers: Layer.mergeAll(Docker.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RivetNode", import.meta.url);

const Cluster = RivetDocker.SwarmControlPlane("RivetNode", { port: CONTROL_PLANE_PORT });

let connection: Rivet.Node.NodeConnection;

/** Host `NodeEcho` in this process until the test's scope closes. */
const serving = Effect.gen(function* () {
  const connected = yield* Deferred.make<void>();
  const node = yield* Rivet.Node.serve([NodeEcho], connection, {
    connected: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
  }).pipe(Effect.forkScoped);
  yield* Effect.raceFirst(Deferred.await(connected), Fiber.join(node));
});

// Retried while the control plane routes the first call to the new node.
const settled = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 15 }));

// A process Alchemy didn't build joins a pool as its node with Node.serve,
// and reaches the classes it hosts with Node.connect.
describe.skipIf(!!process.env.FAST)(
  "Rivet Node",
  { tags: ["provider:rivet", "provider:rivet:durable-object", "local"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const out = (yield* sharedStack.deploy(
          Effect.gen(function* () {
            const cluster = yield* Rivet.Cluster;
            return { token: cluster.token, namespace: cluster.namespace };
          }).pipe(Effect.provide(Cluster)),
        )) as { token: Redacted.Redacted<string>; namespace: string };
        connection = {
          endpoint: `http://localhost:${CONTROL_PLANE_PORT}`,
          token: out.token,
          namespace: out.namespace,
          pool: POOL,
        };
      }),
      { timeout: 400_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 300_000 });

    test(
      "serve hosts a class in this process, and connect calls its instances",
      Effect.scoped(
        Effect.gen(function* () {
          yield* serving;
          const echoes = Rivet.Node.connect(connection)(NodeEcho);
          const first = yield* settled(echoes.getByName("a").increment());
          expect(yield* echoes.getByName("a").increment()).toBe(first + 1);
          expect(yield* echoes.getByName("b").increment()).toBe(1);
        }),
      ),
      { timeout: 120_000 },
    );

    test(
      "connect adds its headers to every call, and a caller's own header wins",
      Effect.scoped(
        Effect.gen(function* () {
          yield* serving;
          const traced = Rivet.Node.connect({
            ...connection,
            headers: () => [["x-trace", "from-connection"]],
          })(NodeEcho).getByName("traced");
          // The stub's `fetch` asks for the RuntimeContext of an Alchemy
          // runtime, which a gateway call never reads.
          const read = (request: Request) =>
            settled(
              (
                traced.fetch(HttpServerRequest.fromWeb(request)) as Effect.Effect<
                  HttpServerResponse.HttpServerResponse,
                  unknown
                >
              ).pipe(
                Effect.flatMap((response) =>
                  Effect.promise(() => HttpServerResponse.toWeb(response).json()),
                ),
              ),
            );
          expect(yield* read(new Request("http://node/"))).toEqual({
            name: "traced",
            trace: "from-connection",
          });
          expect(
            yield* read(new Request("http://node/", { headers: { "x-trace": "from-caller" } })),
          ).toEqual({ name: "traced", trace: "from-caller" });
        }),
      ),
      { timeout: 120_000 },
    );
  },
);
