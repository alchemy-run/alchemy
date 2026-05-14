import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Creates a yieldable client service for a Cloudflare runtime object binding.
 *
 * The binding remains the source of truth for deploy-time attachment; the
 * client service is only the app-facing Effect service produced by binding a
 * specific resource.
 */
export const makeBoundClientService = <Self, Resource, Client, BindingReq>(
  id: string,
  binding: {
    bind: <Req = never>(
      resource: Resource | Effect.Effect<Resource, never, Req>,
    ) => Effect.Effect<Client, never, BindingReq | Req>;
  },
): Context.Service<Self, Client> & {
  layer: <Req = never>(
    resource: Resource | Effect.Effect<Resource, never, Req>,
  ) => Layer.Layer<Self, never, BindingReq | Req>;
} => {
  const tag = Context.Service<Self, Client>(id);

  return Object.assign(tag, {
    layer: <Req = never>(
      resource: Resource | Effect.Effect<Resource, never, Req>,
    ) => Layer.effect(tag, binding.bind(resource)),
  });
};
