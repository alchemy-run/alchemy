#!/usr/bin/env bun
// Probe Cloud Map state left by the failed destroy (and optionally clean up).
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { FetchHttpClient } from "effect/unstable/http";

const ROOT =
  "/Users/samgoodwin/workspaces/alchemy-effect/.claude/worktrees/r2-bucket-cors-v2-a32892";
const { fromChain } = await import(`${ROOT}/distilled/packages/aws/src/credentials.ts`);
const { Region } = await import(`${ROOT}/distilled/packages/aws/src/region.ts`);
const sd = await import(`${ROOT}/distilled/packages/aws/src/services/servicediscovery.ts`);

const clean = process.argv.includes("--clean");

const main = Effect.gen(function* () {
  const ns = yield* sd.listNamespaces({});
  const mine = (ns.Namespaces ?? []).filter((n) =>
    n.Name?.includes("cloudmap-fixture"),
  );
  console.log(
    "fixture namespaces:",
    mine.map((n) => ({ id: n.Id, name: n.Name })),
  );
  const svcs = yield* sd.listServices({});
  for (const s of svcs.Services ?? []) {
    const inst = yield* sd.listInstances({ ServiceId: s.Id! });
    console.log(
      "service",
      s.Id,
      s.Name,
      "instances:",
      (inst.Instances ?? []).map((i) => i.Id),
    );
    if (clean) {
      for (const i of inst.Instances ?? []) {
        console.log("  deregistering", i.Id);
        yield* sd.deregisterInstance({ ServiceId: s.Id!, InstanceId: i.Id! });
      }
      console.log("  deleting service", s.Id);
      yield* sd.deleteService({ Id: s.Id! }).pipe(
        Effect.retry({
          while: (e): boolean => e._tag === "ResourceInUse",
          schedule: Schedule.max([
            Schedule.fixed("10 seconds"),
            Schedule.recurs(30),
          ]),
        }),
      );
      console.log("  deleted");
    }
  }
  if (clean) {
    for (const n of mine) {
      console.log("deleting namespace", n.Id);
      yield* sd.deleteNamespace({ Id: n.Id! });
      console.log("delete namespace requested");
    }
  }
});

const layers = Layer.mergeAll(
  fromChain(),
  Layer.succeed(Region, Effect.succeed("us-west-2" as any)),
  FetchHttpClient.layer,
);

await Effect.runPromise(main.pipe(Effect.provide(layers)) as any);
