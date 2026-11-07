import * as Archil from "@alchemy.run/archil";
import * as Effect from "effect/Effect";

/** The disk every workspace starts from. */
export const Template = Archil.Disk("Template", {});

/** The template's files: cloned and installed once, at deploy time. */
export const Seeded = Effect.gen(function* () {
  const template = yield* Template;
  return yield* Archil.Checkpoint("Seeded", {
    disk: template.diskId,
    name: "seeded",
    run: ["printf '# Notes\\n' > README.md", "mkdir -p notes"],
  });
});

/** The image workspace sandboxes boot. */
export const Agent = Archil.Image("Agent", { image: "node:24-bookworm" });
