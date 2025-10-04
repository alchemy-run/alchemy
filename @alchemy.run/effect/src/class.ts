import type { Resource } from "./resource.ts";

export type Class<R extends Resource> = Resource.Type<
  R["Type"],
  R["Props"],
  R["Attr"]
> &
  (<Props extends R["Props"]>(props: Props) => R["Attr"]);
