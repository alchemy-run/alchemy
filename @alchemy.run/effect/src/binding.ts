import type { Effect } from "effect/Effect";
import type { Attach } from "./plan.ts";
import type { Statement } from "./policy.ts";

export type Binding<Host = any, To extends Statement = Statement> = {
  type: "bound";
  resource: Host;
  bindings: To[];
  props: any;
};

export const isBinding = (value: any): value is Binding =>
  value && typeof value === "object" && value.type === "bound";

export type Binder<Host = any, Stmt extends Statement = Statement> = {
  attach: (props: {
    host: Host;
    binding: Attach<Stmt>;
    oldBinding?: Attach<Stmt>;
    resource: Stmt["resource"]["attributes"];
  }) => Effect<Partial<Host> | void>;
  detach?: (props: {
    host: Host;
    binding: Attach<Stmt>;
    resource: Stmt["resource"]["attributes"];
  }) => Effect<void>;
};
