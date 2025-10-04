import * as Context from "effect/Context";
import type { BindingLifecycle, BindingLike } from "./binding.ts";
import type { Resource } from "./resource.ts";

export type Host<
  Type extends Resource.Kind,
  Binding extends BindingLike,
  Props extends Resource.Props,
> = Context.Tag<
  `${Binding["Verb"]}(${Binding["Resource"]["Type"]}, ${Type})`,
  BindingLifecycle<Binding["Resource"], Props>
>;

export const Host = <
  Type extends Resource.Kind,
  Props extends Record<string, any>,
  Binding extends BindingLike,
>(
  type: Type,
  binding: Binding,
): Host<Type, Binding, Props> =>
  Object.assign(
    Context.Tag(type)<Props, BindingLifecycle<Resource.Type, Props>>(),
    {
      Kind: "Host",
      Type: type,
      Props: undefined! as Props,
      Binding: binding,
    },
  ) as any;
