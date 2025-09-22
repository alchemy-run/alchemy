import type { Statement } from "./policy.ts";
import type { Resource } from "./resource.ts";

export type Bound<
  From extends Resource = Resource,
  To extends Statement = Statement,
> = {
  type: "bound";
  resource: From;
  bindings: To[];
  props: Exclude<From["provider"]["Service"]["props"], undefined>;
  // /**
  //  * The main file to use for the function.
  //  */
  // main: string;
  // /**
  //  * The handler to use for the function.
  //  * @default "default"
  //  */
  // handler?: string;
};

export const isBound = (value: any): value is Bound =>
  value && typeof value === "object" && value.type === "bound";
