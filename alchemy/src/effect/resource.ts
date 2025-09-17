import type * as Context from "effect/Context";

export type ResourceID = string;

export type ResourceProps = Record<string, any>;

export type Resource<
  ID extends ResourceID = ResourceID,
  Props extends ResourceProps = ResourceProps,
> = {
  id: ID;
  props: Props;
};

export type ResourceWithProvider<
  ID extends ResourceID = ResourceID,
  Props extends ResourceProps = ResourceProps,
> = Resource<ID, Props> & {
  provider: Context.Tag<any, any>;
};

export type ExtractProvider<R> = R extends {
  provider: infer P;
}
  ? P
  : never;
