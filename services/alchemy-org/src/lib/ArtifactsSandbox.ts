import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Artifacts } from "./Artifacts.ts";

const DIR = ".tool-output";

/**
 * The artifact store over the session {@link AI.Sandbox} — the
 * Cloudflare sibling of `ArtifactsLocal` (which needs a
 * host filesystem the Durable Object doesn't have). Artifacts are
 * files under `.tool-output/` on the session's OWN machine: written
 * where the output was produced, readable by `readOutput`, and
 * recycled with the container. Host paths still never reach the
 * model — tools return opaque IDs.
 */
export const ArtifactsSandbox = Layer.effect(
  Artifacts,
  Effect.gen(function* () {
    const sandbox = yield* AI.Sandbox;
    let next = 1;

    const pathOf = (id: string) => `${DIR}/${id}.log`;

    return {
      create: (label) =>
        Effect.gen(function* () {
          const safe = label.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
          const id = `output-${next++}-${safe}`;
          yield* sandbox.mkdir(DIR).pipe(Effect.ignore);
          yield* sandbox.writeFile(pathOf(id), "");
          return {
            id,
            append: (chunk: string) =>
              // Sandbox has no append primitive; artifacts are written
              // once (occasionally twice) per tool call, so read+concat
              // is fine at this cadence
              sandbox
                .readFile(pathOf(id))
                .pipe(
                  Effect.orElseSucceed(() => ""),
                  Effect.flatMap((existing) =>
                    sandbox.writeFile(pathOf(id), existing + chunk),
                  ),
                ),
          };
        }),
      read: (id) => sandbox.readFile(pathOf(id)),
      size: (id) =>
        sandbox.readFile(pathOf(id)).pipe(Effect.map((text) => text.length)),
    };
  }),
);
