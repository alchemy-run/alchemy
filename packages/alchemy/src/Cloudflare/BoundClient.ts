import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/**
 * Creates a yieldable client service for a Cloudflare runtime object binding.
 *
 * The binding remains the source of truth for deploy-time attachment. The
 * layer requires an already-bound client value so callers must run
 * `yield* Resource.bind(resource)` in the Worker's init effect, where Alchemy
 * can discover the deploy-time binding.
 */
export const makeBoundClientService = <Self, Client>(
  id: string,
): Context.Service<Self, Client> & {
  layer: (client: Client) => Layer.Layer<Self>;
} => {
  const tag = Context.Service<Self, Client>(id);

  return Object.assign(tag, {
    layer: (client: Client) => Layer.succeed(tag, client),
  });
};
