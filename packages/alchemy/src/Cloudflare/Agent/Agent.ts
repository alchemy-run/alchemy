import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AI from "../../Agent/index.ts";
import type { DurableObjectServices } from "../Workers/DurableObjectNamespace.ts";

export declare const Agent: {
  <Self>(): {
    <Name extends string>(
      name: Name,
    ): {
      <const Refs extends any[]>(
        template: TemplateStringsArray,
        ...args: Refs
      ): {
        new (): AI.AgentService;
        make(
          layer: Layer.Layer<AI.Services<Refs>, never, DurableObjectServices>,
        ): Layer.Layer<Self>;
        (
          layer: Layer.Layer<AI.Services<Refs>, never, DurableObjectServices>,
        ): Effect.Effect<any, never, Refs> & {
          new (): AI.AgentService;
        };
      };
    };
  };
};
