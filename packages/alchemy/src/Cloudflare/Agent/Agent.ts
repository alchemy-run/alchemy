import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as AI from "../../Agent/index.ts";
import type { DurableObjectServices } from "../Workers/DurableObjectNamespace.ts";

export declare const makeAgent: {
  <A extends AI.Agent<any, any, any>>(
    agent: A,
  ): {
    <
      Eff extends Effect.Effect<any, any, any>,
      AReq extends DurableObjectServices = never,
    >(
      f: (
        this: Layer.Layer<InstanceType<A>, never, AI.Services<A["refs"]>>,
        self: Layer.Layer<InstanceType<A>, never, AI.Services<A["refs"]>>,
      ) => Layer.Layer<InstanceType<A>, never, AReq>,
    ): Layer.Layer<
      InstanceType<A>,
      [Eff] extends [never]
        ? never
        : [Eff] extends [Effect.Effect<infer _A, infer E, infer _R>]
          ? E
          : never,
      DurableObjectServices | [Eff] extends [never]
        ? never
        : [Eff] extends [Effect.Effect<infer _A, infer _E, infer R>]
          ? R
          : never
    >;
  };
};
