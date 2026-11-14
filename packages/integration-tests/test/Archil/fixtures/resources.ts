import * as Archil from "@alchemy.run/archil";
import * as Effect from "effect/Effect";

/** A shared disk the bindings read, write, exec and mount. */
export const Dataset = Archil.Disk("Dataset", {});

/** A disk seeded once, then branched per session. */
export const Seed = Archil.Disk("Seed", {});

/** The checkpoint run-time branches fork from. */
export const SEED_CHECKPOINT = "base";

export const SeedBase = Effect.gen(function* () {
  const seed = yield* Seed;
  return yield* Archil.Checkpoint("SeedBase", {
    disk: seed.diskId,
    name: SEED_CHECKPOINT,
    run: ["echo seeded > marker.txt"],
  });
});

/** A small public image for run-time sandboxes. */
export const Agent = Archil.Image("Agent", { image: "alpine:3.20" });

/** A deploy-time sandbox the Worker drives with ConnectSandbox. */
export const Preview = Archil.Sandbox("Preview", {
  // Node runs the echo server the getTcpPort tests call.
  baseImage: "node:24-alpine",
  idleTtlSeconds: 300,
});
