import type * as Effect from "effect/Effect";
import type { InstanceOf, Resource, ResourceLike } from "./resource.ts";

export type BindingLike = {
  Resource: Resource;
  Verb: string;
};

export type Binding<
  Verb extends string = string,
  Res extends { Type: string } = Resource,
> = {
  Kind: "Binding";
  Verb: Verb;
  Resource: Res;
  Type: Res["Type"];
};

export const Binding = <
  const Verb extends string,
  const Res extends ResourceLike,
>(
  verb: Verb,
  resource: Res,
) =>
  Object.assign(
    (resource: InstanceOf<Res>, props?: any) => ({
      resource,
      props,
    }),
    {
      Kind: "Binding",
      Verb: verb,
      Resource: resource,
      Type: resource.Type,
    },
  ) as Binding<Verb, Res>;
// class {
//   static readonly Kind = "Binding";
//   static readonly Verb = verb;
//   static readonly Resource = resource;
//   static readonly Tag =
//     `${verb}<${resource.Type}>` as `${Verb}<${Res["Type"]}>`;

//   readonly Tag;
//   constructor(readonly resource: InstanceOf<Res>) {
//     this.Tag = `${verb}<${resource.Type}>` as `${Verb}<${Res["Type"]}>`;
//   }
// } as any as Binding<Verb, Res>;

export type BindingLifecycle<
  Resource extends Resource.Type = Resource.Type,
  Host extends Resource.Props = Resource.Props,
  AttachReq = any,
  DetachReq = any,
> = {
  attach: (
    resource: Resource["Attr"],
    to: Host,
  ) =>
    | Effect.Effect<Partial<Host> | void, never, AttachReq>
    | Partial<Host>
    | void;
  detach?: (
    resource: Resource["Attr"],
    from: Host,
  ) => Effect.Effect<void, never, DetachReq>;
};
