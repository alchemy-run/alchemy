/**
 * A process hosted on a Domain platform: each session an object of the
 * platform's own, beside whatever models it hosts. Cloudflare, Rivet and
 * Effect Cluster share this, and differ only in the platform Layer.
 *
 * @module
 */
import { unwrapDefects } from "@alchemy.run/domain/DurableObjects";
import { Platform } from "@alchemy.run/domain/Platform";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Host from "../Host.ts";

/** The owner of every process's classes on a platform: `AI.TriageProcess`. */
const OWNER = "AI";

/**
 * Host every process `layer` provides on the Domain platform it is given:
 * one class per process, one object per session.
 */
export const layerObjects = <A, E, R>(
  layer: Layer.Layer<A, E, R>,
): Layer.Layer<A, E, Exclude<R, A> | Platform> =>
  Host.make(layer, (name, instance) =>
    Effect.gen(function* () {
      const platform = yield* Platform;
      if (platform.objects === undefined) {
        return yield* Effect.die(
          new Error(
            `This platform keeps everything in one process, so it has no object to give each session of ${name}. Host the process with AI.layerInMemory there.`,
          ),
        );
      }
      const namespace = yield* platform.objects(
        OWNER,
        `${name}Process`,
        // Each object builds the process for itself: a harness opens on its storage.
        Effect.map(instance({ apart: true }), ({ call }) => ({ call })),
      );
      return {
        call: (key, method, args) =>
          unwrapDefects(namespace.getByName(key).call!(key, method, args)),
      } satisfies Host.Instances;
    }),
  );
