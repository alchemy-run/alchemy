import { makeLocalState, type ResourceState } from "@/State";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { deploymentStoreConformance } from "./deploymentStoreConformance.ts";

// One temp root shared by every `make()` call so the persistence case's two
// store instances observe the same underlying storage. Never the repo's
// `.alchemy` — this is a throwaway directory in the OS temp location.
let root: string | undefined;

const make = () =>
  Effect.gen(function* () {
    if (root === undefined) {
      const fs = yield* FileSystem.FileSystem;
      root = yield* fs.makeTempDirectory({
        prefix: "alchemy-local-deployments-",
      });
    }
    return yield* makeLocalState({ rootDir: root });
  }).pipe(Effect.provide(NodeServices.layer));

deploymentStoreConformance({
  label: "Local DeploymentStore",
  make,
  persistent: true,
});

describe("Local DeploymentStore isolation", () => {
  const resource = (fqn: string): ResourceState => ({
    resourceType: "test:resource",
    namespace: undefined,
    fqn,
    logicalId: fqn,
    instanceId: `instance-${fqn}`,
    providerVersion: 1,
    status: "created",
    downstream: [],
    bindings: [],
    props: {},
    attr: {},
  });

  it.effect(
    "resource list()/getAll()/listStages() ignore the .deployments directory",
    () =>
      Effect.gen(function* () {
        const state = yield* make();
        const stack = "local-deployments-isolation";
        const stage = "main";

        const a = resource("resource-a");
        yield* state.set({ stack, stage, fqn: a.fqn, value: a });

        const { version, token } = yield* state.deployments!.begin({
          stack,
          stage,
          meta: { command: "deploy" },
        });
        yield* state.deployments!.appendEvents({
          stack,
          stage,
          version,
          token,
          events: [{ seq: 1, ts: 10, payload: { kind: "note" } }],
        });

        // Resource-facing reads must not see the reserved `.deployments` dir.
        expect(yield* state.list({ stack, stage })).toEqual(["resource-a"]);
        const all = yield* state.getAll!({ stack, stage });
        expect(Array.from(all.keys())).toEqual(["resource-a"]);
        expect(yield* state.listStages(stack)).toEqual([stage]);
      }),
  );
});
