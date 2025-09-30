import * as Effect from "effect/Effect";

import type {
  Binding,
  Handler,
  Policy,
  Statement,
  TagInstance,
} from "@alchemy.run/effect";
import type { FunctionProvider } from "./function.provider.ts";
import type { Function } from "./function.ts";

type MakeFunctionProps<Req> = (Extract<Req, Statement> extends never
  ? {
      bindings?: undefined;
    }
  : {
      bindings: NoInfer<Policy<Extract<Req, Statement>>>;
    }) & {
  main: string;
  handler?: string;
};

export const make = <F extends Handler<Req, any, any> | Function, Req>(
  self: F,
  { bindings, main, handler }: MakeFunctionProps<Req>,
) => {
  const eff = Effect.gen(function* () {
    return {
      ...(Object.fromEntries(
        bindings?.statements.map((statement) => [
          statement.resource.id,
          statement.resource,
        ]) ?? [],
      ) as {
        [id in Extract<Req, Statement>["resource"]["id"]]: Extract<
          Extract<Req, Statement>["resource"],
          { id: id }
        >;
      }),
      [self.id]: {
        type: "bound",
        resource: self,
        bindings: bindings?.statements ?? [],
        // TODO(sam): this should be passed to an Effect that interacts with the Provider
        props: {
          // ...self.props,
          main,
          handler,
        },
      } satisfies Binding<F, Extract<Req, Statement>>,
    };
  });

  const clss: any = class {};
  Object.assign(clss, eff);
  clss.pipe = eff.pipe.bind(eff);
  return clss as any as Effect.Effect<
    {
      [id in F["id"]]: F extends Function
        ? Binding<F, Extract<Req, Statement>>
        : F;
    } & {
      [id in Exclude<
        Extract<Req, Statement>["resource"]["id"],
        F["id"]
      >]: Extract<Extract<Req, Statement>["resource"], { id: id }>;
    },
    never,
    | FunctionProvider
    | TagInstance<Extract<Req, Statement>["resource"]["provider"]>
  >;
};
