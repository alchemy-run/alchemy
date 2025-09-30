import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { Statement } from "./policy.ts";

export type Handler<
  Req = never,
  Type extends string = any,
  ID extends string = any,
  // Attributes extends S.Struct.Fields,
  Stmt extends Statement = Statement,
  Eff extends Effect.Effect<any, any, any> = Effect.Effect<any, any, any>,
> = Context.Tag<ID, any> &
  Effect.Effect<any, any, Req> & {
    type: Type;
    id: ID;
    // attributes: Attributes;
    binding: Stmt;
    handler: (event: any, context: any) => Eff;
  };

/**
 * An absatract handler (a handler function not yet placed in a physical compute resource, e.g. an AWS Lambda function, EC2 instance, etc.)
 */
export const Handler = <
  const Type extends string,
  const ID extends string,
  // Attributes extends S.Struct.Fields,
  Stmt extends Statement,
  Eff extends Effect.Effect<any, any, any>,
>(props: {
  type: Type;
  id: ID;
  // attributes: Attributes;
  binding: Stmt;
  handler: (event: any, context: any) => Eff;
}) =>
  Object.assign(
    Effect.gen(function* () {
      return props.handler;
    }),
    Object.assign(Context.Tag(props.id)<ID, any>(), props),
  );
