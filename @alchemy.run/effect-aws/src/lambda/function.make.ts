import * as Effect from "effect/Effect";

import type {
  BoundDecl,
  Policy,
  Service,
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

export const make = <S extends Service>(
  self: S,
  { bindings, main, handler }: MakeFunctionProps<S["Req"]>,
) => {
  type Req = S["Req"];
  const eff = Effect.gen(function* () {
    return {
      ...(Object.fromEntries(
        bindings?.statements.map((statement) => [
          statement.resource.ID,
          statement.resource,
        ]) ?? [],
      ) as {
        [id in Extract<Req, Statement>["resource"]["ID"]]: Extract<
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
      } satisfies BoundDecl<S, Extract<Req, Statement>>,
    };
  });

  const clss: any = class {};
  Object.assign(clss, eff);
  clss.pipe = eff.pipe.bind(eff);
  return clss as any as Effect.Effect<
    {
      [id in S["id"]]: S extends Function
        ? BoundDecl<S, Extract<Req, Statement>>
        : S;
    } & {
      [id in Exclude<
        Extract<Req, Statement>["resource"]["ID"],
        S["id"]
      >]: Extract<Extract<Req, Statement>["resource"], { id: id }>;
    },
    never,
    | FunctionProvider
    | TagInstance<Extract<Req, Statement>["resource"]["provider"]>
  >;
};
