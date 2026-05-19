import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface BindingTag<
  Self,
  Id extends string,
  Client,
  BindError = never,
  BindRequirements = never,
> extends Context.Service<Self, Client> {
  readonly id: Id;
  /**
   * Bind the configured resource to the surrounding Worker and return the
   * runtime client. This is the deploy-discoverable operation; call it from
   * Worker init, not lazily inside request handlers.
   */
  readonly bind: Effect.Effect<Client, BindError, BindRequirements>;
  /**
   * Bind the configured resource and return a layer that provides this tag.
   * This keeps deploy-time binding discovery in Worker init while allowing
   * application services to depend on the generated tag.
   */
  readonly layer: Effect.Effect<Layer.Layer<Self>, BindError, BindRequirements>;
}

export const makeBindingTag = <
  Self,
  Id extends string,
  Client,
  BindError = never,
  BindRequirements = never,
>(
  id: Id,
  bind: Effect.Effect<Client, BindError, BindRequirements>,
): BindingTag<Self, Id, Client, BindError, BindRequirements> => {
  const tag = Context.Service<Self, Client>()(id);
  const layer = bind.pipe(Effect.map((client) => Layer.succeed(tag, client)));

  return Object.assign(tag, {
    id,
    bind,
    layer,
  });
};
