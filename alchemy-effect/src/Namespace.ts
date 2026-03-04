import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ServiceMap from "effect/ServiceMap";

export interface NamespaceNode {
  Id: string;
  Parent?: NamespaceNode;
}

export class Namespace extends ServiceMap.Service<Namespace, NamespaceNode>()(
  "Alchemy/Namespace",
) {}

export function namespace<const Id extends string, A, Err = never, Req = never>(
  id: Id,
  eff: Effect.Effect<A, Err, Req>,
): Effect.Effect<A, Err, Req>;

export function namespace<const Id extends string>(
  id: Id,
): <A, Err = never, Req = never>(
  eff: Effect.Effect<A, Err, Req>,
) => Effect.Effect<A, Err, Req>;

export function namespace(id: string, eff?: Effect.Effect<any, any, any>) {
  return eff
    ? Effect.flatMap(CurrentNamespace, (parent) =>
        Effect.provideService(eff, Namespace, {
          Id: id,
          Parent: parent,
        }),
      )
    : (eff: Effect.Effect<any, any, any>) => namespace(id, eff);
}

export const CurrentNamespace = Effect.serviceOption(Namespace)
  .asEffect()
  .pipe(Effect.map(Option.getOrUndefined));

export const Parent = Namespace.asEffect().pipe(Effect.map((ns) => ns?.Parent));

export const Root = Namespace.asEffect().pipe(
  Effect.map(function findRoot(ns) {
    if (ns.Parent) {
      return findRoot(ns.Parent);
    }
    return ns;
  }),
);
