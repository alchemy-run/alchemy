import type * as Context from "effect/Context";

export type ResourceID = string;
export type Props = Record<string, any>;
export type Attributes = Record<string, any>;
export type ProviderTag = Context.Tag<any, any>;

export type Resource<
  Type extends string = string,
  ID extends ResourceID = ResourceID,
  P extends Props = Props,
  A extends Attributes = Attributes,
  Provider extends ProviderTag = ProviderTag,
> = {
  type: Type;
  id: ID;
  props: P;
  /** @internal phantom type */
  attributes: A;
  provider: Provider;
};
