import type { Statement } from "./policy.ts";
import type { Resource } from "./resource.ts";

export type Bound<
  From extends Resource = Resource,
  To extends Statement = Statement,
> = {
  type: "bound";
  target: From;
  bindings: To[];
};

export const isBound = (value: any): value is Bound =>
  value && typeof value === "object" && value.type === "bound";
