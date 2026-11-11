import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { type BoxName, BunBox, NodeBox } from "./containers.ts";

/**
 * One Durable Object bound to two Effect-native Containers. Each request
 * names the one to run: the object stops the other image first, because
 * every handle controls the object's one container instance.
 */
export class Selector extends Cloudflare.DurableObject<Selector>()(
  "Selector",
  Effect.gen(function* () {
    const boxes = { bun: yield* BunBox, node: yield* NodeBox };
    const state = yield* Cloudflare.DurableObjectState;

    const select = Effect.fn(function* (name: BoxName) {
      const box = boxes[name];
      const current = yield* state.storage.get<BoxName>("current");
      if (current !== name && (yield* box.running)) {
        yield* box.destroy();
      }
      yield* state.storage.put("current", name);
      // start() runs this Container's own image with its declared env; the
      // caller's env is merged over it.
      yield* box.start({ enableInternet: false, env: { CALLER: "selector" } });
      return box;
    });

    return Effect.succeed({
      run: Effect.fn(function* (name: BoxName) {
        const box = yield* select(name);
        return {
          identity: yield* box.whoami(),
          echo: yield* box.echo("hi"),
          image: yield* box.image,
          images: Object.keys(state.container?.images ?? {}).sort(),
        };
      }),
    });
  }),
) {}
