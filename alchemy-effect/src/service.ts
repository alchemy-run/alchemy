import type { Effect } from "effect/Effect";
import type { Capability } from "./capability.ts";
import type { IResource } from "./resource.ts";
import type { Runtime, RuntimeHandler, RuntimeProps } from "./runtime.ts";

export interface IService<
  ID extends string = string,
  F extends Runtime = Runtime,
  Handler extends RuntimeHandler = RuntimeHandler,
  Props extends RuntimeProps<F, any> = RuntimeProps<F, any>,
  Attr = (F & { props: Props })["attr"],
  Base = unknown,
> extends IResource<F["type"], ID, Props, Attr, Base> {
  kind: "Service";
  type: F["type"];
  id: ID;
  runtime: F;
  /**
   * The raw handler function as passed in to the Runtime.
   *
   * @internal phantom type
   */
  impl: Handler;
  /**
   * An Effect that produces a handler stripped of its Infrastructure-time-only Capabilities.
   */
  handler: Effect<
    (
      ...inputs: Parameters<Handler>
    ) => Effect<
      Effect.Success<ReturnType<Handler>>,
      Effect.Error<ReturnType<Handler>>,
      never
    >,
    never,
    Exclude<Effect.Context<ReturnType<Handler>>, Capability>
  >;
  props: Props;
  /** @internal phantom type of this resource's output attributes */
  attr: Attr;
  /** @internal phantom type of this resource's parent */
  parent: unknown;
  new (): Service<ID, F, Handler, Props, Attr, Base>;
}

export interface AnyService extends IService {}

export interface Service<
  ID extends string = string,
  F extends Runtime = Runtime,
  Handler extends RuntimeHandler = RuntimeHandler,
  Props extends RuntimeProps<F, any> = RuntimeProps<F, any>,
  Attr = (F & { props: Props })["attr"],
  Base = unknown,
> extends IService<ID, F, Handler, Props, Attr, Base> {}

export const isService = (resource: any): resource is IService => {
  return resource && resource.kind === "Service";
};
