/**
 * A process hosted on objects: each session an object of the platform's
 * own. Cloudflare, Rivet and Effect Cluster share this, and differ only in
 * the object host they provide.
 *
 * @module
 */
import { ObjectHost, unwrapDefects } from "alchemy/Workers/ObjectHost";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Host from "../Host.ts";

/**
 * Host every process `layer` provides on the object host it is given: one
 * class per process, `AI.<Name>Process`, and one object per session.
 */
export const layerObjects = <A, E, R>(
  layer: Layer.Layer<A, E, R>,
): Layer.Layer<A, E, Exclude<R, A> | ObjectHost> =>
  Host.make(layer, (name, instance) =>
    Effect.gen(function* () {
      const objects = yield* ObjectHost;
      const namespace = yield* objects.declare(
        `AI.${name}Process`.replace(/[^A-Za-z0-9_.]/g, "_"),
        // Each object builds the process for itself: a harness opens on its storage.
        Effect.map(instance({ apart: true }), ({ call }) => ({ call })),
      );
      return {
        call: (key, method, args) =>
          unwrapDefects(namespace.getByName(key).call!(key, method, args)),
      } satisfies Host.Instances;
    }),
  );
