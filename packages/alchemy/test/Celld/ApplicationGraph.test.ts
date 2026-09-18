import {
  prepareApplicationGraph,
  APPLICATION_GRAPH_METADATA,
} from "@/Celld/ApplicationGraph.ts";
import { prepareDeployment } from "@/Celld/Deployment.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const worker = (
  scriptName: string,
  content = "export default {fetch(){return new Response('ok')}}",
  crons: readonly string[] = [],
) =>
  prepareDeployment({
    scriptName,
    mainModule: "index.js",
    modules: [{ name: "index.js", content }],
    metadata: { main_module: "index.js", bindings: [] },
    doClasses: [],
    sqliteClasses: [],
    crons,
  });

describe("Celld Application graph identity", () => {
  it.effect("preserves explicitly installed native system classes", () =>
    Effect.gen(function* () {
      const root = yield* prepareDeployment({
        scriptName: "root",
        mainModule: "index.js",
        modules: [{ name: "index.js", content: "export default {}" }],
        metadata: { main_module: "index.js", bindings: [] },
        doClasses: [],
        sqliteClasses: [],
        systemClasses: ["d1", "kv", "queues"],
      });
      const graph = yield* prepareApplicationGraph(root, []);
      expect(graph.root.manifest.do_classes).toEqual(root.manifest.do_classes);
      expect(graph.root.manifest.sqlite_classes).toEqual(
        root.manifest.sqlite_classes,
      );
      expect(graph.root.manifest.required_features).toEqual(
        root.manifest.required_features,
      );
    }),
  );
  it.effect(
    "changes the native root version for secondary code and cron-only changes",
    () =>
      Effect.gen(function* () {
        const root = yield* worker("root");
        const jobs = yield* worker("jobs");
        const first = yield* prepareApplicationGraph(root, [jobs]);
        const updated = yield* prepareApplicationGraph(root, [
          yield* worker(
            "jobs",
            "export default {fetch(){return new Response('updated')}}",
          ),
        ]);
        expect(updated.root.version).not.toBe(first.root.version);
        const scheduled = yield* worker("root", undefined, ["* * * * *"]);
        expect(scheduled.version).toBe(root.version);
        const changedSchedule = yield* prepareApplicationGraph(scheduled, [
          jobs,
        ]);
        expect(changedSchedule.root.version).not.toBe(first.root.version);
        expect(changedSchedule.root.manifest.crons).toEqual(["* * * * *"]);
      }),
  );
  it.effect(
    "makes all secondary Workers reachable in a deterministic native service graph",
    () =>
      Effect.gen(function* () {
        const root = yield* worker("root");
        const first = yield* worker("first");
        const second = yield* worker("second");
        const a = yield* prepareApplicationGraph(root, [second, first]);
        const b = yield* prepareApplicationGraph(root, [first, second]);
        expect(a.root.version).toBe(b.root.version);
        expect(a.root.manifest.raw_metadata).toEqual(
          expect.objectContaining({
            bindings: [
              {
                type: "service",
                name: "__ALCHEMY_APP_WORKER_0",
                service: "first",
              },
              {
                type: "service",
                name: "__ALCHEMY_APP_WORKER_1",
                service: "second",
              },
            ],
            [APPLICATION_GRAPH_METADATA]: expect.objectContaining({
              revision: a.revision,
            }),
          }),
        );
      }),
  );
  it.effect(
    "refuses to reinterpret an already graph-bound root as a staged Worker",
    () =>
      Effect.gen(function* () {
        const graph = yield* prepareApplicationGraph(yield* worker("root"), []);
        const result = yield* Effect.result(
          prepareApplicationGraph(graph.root, []),
        );
        expect(Result.isFailure(result)).toBe(true);
      }),
  );
});
