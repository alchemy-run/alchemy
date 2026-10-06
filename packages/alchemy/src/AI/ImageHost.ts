import * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { ImageLayer } from "../Docker/ImageLayer.ts";
import type { Resource, ResourceLike } from "../Resource.ts";

/** Host types whose binding contract accepts `image` layers (and `env`). */
const IMAGE_HOSTS = new Set(["Cloudflare.Container"]);

type ImageBindingHost = Resource<
  string,
  object | undefined,
  object,
  { image?: ImageLayer[]; env?: Record<string, unknown> }
>;

const isImageHost = (host: ResourceLike): host is ImageBindingHost => IMAGE_HOSTS.has(host.Type);

/**
 * Deploy-time half of a binding that installs itself into the image of the
 * host it is yielded in: binds `{ image, env }` under `key`. A no-op inside
 * the deployed host and outside any host (plain scripts, tests).
 */
export const bindIntoImageHost = (
  key: string,
  data: { readonly image?: ReadonlyArray<ImageLayer>; readonly env?: Record<string, unknown> },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return;
    const host = yield* Binding.Host;
    if (!host) return;
    if (!isImageHost(host)) {
      return yield* Effect.die(
        new Error(
          `${key}: installs into a container host (${[...IMAGE_HOSTS].join(", ")}), got ${host.Type}`,
        ),
      );
    }
    yield* host.bind`${key}`({
      ...(data.image?.length ? { image: [...data.image] } : {}),
      ...(data.env && Object.keys(data.env).length > 0 ? { env: data.env } : {}),
    });
  });
