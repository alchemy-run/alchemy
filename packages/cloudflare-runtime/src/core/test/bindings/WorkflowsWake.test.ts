import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Workflows from "../../bindings/workflows/Workflows.ts";
import * as Docker from "../../Docker.ts";
import * as Globals from "../../globals/Globals.ts";
import * as Internet from "../../globals/Internet.ts";
import * as Storage from "../../globals/Storage.ts";
import * as Paths from "../../internal/Paths.ts";
import * as Runtime from "../../Runtime.ts";
import * as RuntimeServices from "../../RuntimeServices.ts";
import * as Workerd from "../../workerd/Workerd.ts";
import { makeTempDirectory, PredicateFailed, startTestWorker } from "../helpers/runtime.ts";

const WAKE_SCRIPT = `
import { WorkflowEntrypoint } from "cloudflare:workers";
export class WakeWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    if (event.payload.kind === "sleep") {
      await step.sleep("nap", "2 seconds");
      return "woke";
    }
    try {
      await step.waitForEvent("approval", { type: "approved", timeout: "2 seconds" });
      return "approved";
    } catch {
      return "timed-out";
    }
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (url.pathname === "/create") {
      const instance = await env.WAKE_WORKFLOW.create({
        id,
        params: { kind: url.searchParams.get("kind") },
      });
      return Response.json(await instance.status());
    }
    const instance = await env.WAKE_WORKFLOW.get(id);
    return Response.json(await instance.status());
  },
};
`;

type Status = { status: string; output?: unknown };

const startWakeWorker = startTestWorker({
  name: "workflows-wake-test",
  compatibilityDate: "2026-03-09",
  compatibilityFlags: [],
  modules: [{ name: "main.js", type: "ESModule", content: WAKE_SCRIPT }],
  workflows: [{ workflowName: "WAKE_WORKFLOW", className: "WakeWorkflow" }],
  bindings: [
    Workflows.local({
      binding: "WAKE_WORKFLOW",
      workflowName: "WAKE_WORKFLOW",
      className: "WakeWorkflow",
    }),
  ],
});

/** A local runtime over `storageDir`: closing its scope stops workerd, like an `alchemy dev` restart. */
const runtimeLayer = (storageDir: string) =>
  Runtime.RuntimeLive.pipe(
    Layer.provideMerge(RuntimeServices.layerLocalBindings()),
    Layer.provide(Globals.GlobalsLive),
    Layer.provideMerge(RuntimeServices.layerLoopback()),
    Layer.provide(Storage.layerDisk(storageDir)),
    Layer.provide(Internet.InternetLive),
    Layer.provideMerge(RuntimeServices.layerRegistry()),
    Layer.provide(Paths.PathsLive),
    Layer.provide(Docker.DockerLive),
    Layer.provide(Workerd.WorkerdLive),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );

/** Run `use` against a freshly started runtime, then stop it. */
const withRuntime = <A, E, R>(
  storageDir: string,
  use: (worker: Effect.Success<typeof startWakeWorker>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const worker = yield* startWakeWorker;
    return yield* use(worker);
  }).pipe(Effect.provide(runtimeLayer(storageDir)), Effect.scoped);

/**
 * Poll the instance status until `finished`. Reading the status is the only
 * interaction: nothing pokes the instance, so the engine has to wake itself.
 */
const awaitFinished = (
  worker: Effect.Success<typeof startWakeWorker>,
  id: string,
  timeoutMs: number,
) =>
  worker.fetchJson<Status>(`/status?id=${id}`).pipe(
    Effect.flatMap((status) =>
      status.status === "complete" || status.status === "errored"
        ? Effect.succeed(status)
        : Effect.fail(new PredicateFailed({ value: status })),
    ),
    Effect.retry({
      while: (error) => error._tag === "PredicateFailed",
      schedule: Schedule.spaced("100 millis"),
      times: timeoutMs / 100,
    }),
  );

// Real time, real workerd: the sleeps below are 2 seconds long.
describe("Workflows durable wake-ups", () => {
  it.live(
    "wakes a sleeping instance without a restart",
    () =>
      Effect.gen(function* () {
        const dir = yield* makeTempDirectory("workflows-wake-");
        const status = yield* withRuntime(dir, (worker) =>
          Effect.gen(function* () {
            yield* worker.fetch("/create?id=plain&kind=sleep");
            return yield* awaitFinished(worker, "plain", 8_000);
          }),
        );
        expect(status).toMatchObject({ status: "complete", output: "woke" });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 30_000 },
  );

  describe.each([
    ["sleep", "woke"],
    ["wait", "timed-out"],
  ] as const)("a %s that outlives a runtime restart", (kind, output) => {
    it.live(
      "wakes when the deadline is still ahead after the restart",
      () =>
        Effect.gen(function* () {
          const dir = yield* makeTempDirectory("workflows-wake-");
          const id = `ahead-${kind}`;
          yield* withRuntime(dir, (worker) =>
            Effect.gen(function* () {
              yield* worker.fetch(`/create?id=${id}&kind=${kind}`);
              // Let the engine reach the sleep / wait and persist its deadline.
              yield* Effect.sleep("300 millis");
            }),
          );
          const status = yield* withRuntime(dir, (worker) => awaitFinished(worker, id, 10_000));
          expect(status).toMatchObject({ status: "complete", output });
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      { timeout: 40_000 },
    );

    it.live(
      "wakes when the deadline passed while the runtime was down",
      () =>
        Effect.gen(function* () {
          const dir = yield* makeTempDirectory("workflows-wake-");
          const id = `past-${kind}`;
          yield* withRuntime(dir, (worker) =>
            Effect.gen(function* () {
              yield* worker.fetch(`/create?id=${id}&kind=${kind}`);
              yield* Effect.sleep("300 millis");
            }),
          );
          // Stay down past the 2 second deadline.
          yield* Effect.sleep("2500 millis");
          const status = yield* withRuntime(dir, (worker) => awaitFinished(worker, id, 10_000));
          expect(status).toMatchObject({ status: "complete", output });
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      { timeout: 40_000 },
    );
  });
});
