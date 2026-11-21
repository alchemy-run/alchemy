import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import type { Status } from "alchemy/Workflows";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { ensureDockerSwarm } from "../Docker/Runtime.ts";
import { conformance } from "../Workflows/conformance/conformance.ts";
import { WORKFLOW_FRONT_PORT } from "./fixtures/workflow-cluster.ts";
import WorkflowFront from "./fixtures/workflow-front.ts";

class NotReady extends Data.TaggedError("NotReady")<{ readonly message: string }> {}

const testOptions = { providers: Layer.mergeAll(Docker.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const stack = Core.scratchStack(testOptions, "RivetWorkflows", import.meta.url);

const url = `http://localhost:${WORKFLOW_FRONT_PORT}`;

/** A front route's body, failing with `NotReady` until it answers 200. */
const fetchText = (path: string, method: "GET" | "POST" = "GET") =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* method === "POST"
      ? client.post(`${url}${path}`)
      : client.get(`${url}${path}`);
    const body = yield* response.text;
    if (response.status !== 200) {
      return yield* new NotReady({
        message: `${method} ${path}: HTTP ${response.status}: ${body}`,
      });
    }
    return body;
  });

// The Workflows conformance suite, with every execution a Rivet Durable
// Object on a local Docker control plane, started from a Docker service
// through the gateway.
describe.skipIf(!!process.env.FAST)(
  "Workflows on Rivet",
  { tags: ["provider:rivet", "provider:rivet:workflows", "local"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        if (!process.env.NO_DESTROY) yield* stack.destroy();
        const outputs = yield* stack.deploy(
          Effect.gen(function* () {
            const front = yield* WorkflowFront;
            return { front: front.name };
          }),
        );
        expect(outputs.front).toBeTruthy();
        // The pool's nodes take a while to start: wait until a run completes.
        const id = `probe-${crypto.randomUUID().slice(0, 8)}`;
        const { executionId } = JSON.parse(
          yield* fetchText(`/start/Greet/${id}`, "POST").pipe(
            Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 60 }),
          ),
        ) as { executionId: string };
        yield* Effect.gen(function* () {
          const status = JSON.parse(
            yield* fetchText(`/status/Greet/${id}?executionId=${executionId}`),
          ) as Status<unknown, unknown>;
          if (status._tag !== "Completed") {
            return yield* new NotReady({ message: JSON.stringify(status) });
          }
        }).pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }));
      }),
      { timeout: 400_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(stack.destroy(), { timeout: 300_000 });

    conformance({
      test,
      url: Effect.succeed(url),
      napsWithinMillis: 20_000,
      // A failed run is retried with the callbacks' backoff: 2 then 4 seconds,
      // then the one-second sleep.
      recoveryWithinMillis: 30_000,
      tags: ["provider:rivet", "provider:rivet:workflows", "local"],
      timeout: 90_000,
    });
  },
);
