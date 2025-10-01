import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { Statement } from "./policy.ts";
import type { Resource } from "./resource.ts";

export type ServiceRoot<
  Stmt extends Statement = Statement,
  Handler extends (...inputs: any[]) => any = any,
> = {
  type: string;
  stmt: Stmt;
  /** @deprecated this is a phantom, do not access it at runtime */
  handler: Handler;
};

export type ServiceBinding<
  Handler extends (...inputs: any[]) => any = any,
  Type extends string = any,
  Src extends Resource = Resource,
  To extends Resource = Resource,
> = Context.Tag<
  Type,
  {
    attach(src: Src["attributes"], to: To["attributes"]): Effect.Effect<void>;
    detach(src: Src["attributes"], from: To["attributes"]): Effect.Effect<void>;
  }
> & {
  type: Type;
  src: Src;
  to: To;
  handler: Handler;
  new <const Stmt extends Statement = Statement>(
    stmt: Stmt,
  ): ServiceRoot<Stmt, Handler>;
};

export const Service =
  <const Type extends string = any>(type: Type) =>
  <Handler extends (...inputs: any[]) => any>() =>
    Object.assign(
      class {
        static readonly type = type;
        static readonly handler: Handler = undefined!;
        static readonly src: Resource = undefined!;
        static readonly to: Resource = undefined!;

        readonly type = type;
        readonly stmt: Statement;
        readonly handler: Handler = undefined!;
        constructor(stmt: Statement) {
          this.stmt = stmt;
        }
      },
      Context.Tag(type)(),
    ) as ServiceBinding<Handler, Type, Resource, Resource>;

export const service =
  <const ID extends string, Svc extends ServiceRoot, const Err, Req>(
    id: ID,
    svc: Svc,
    handler: (
      ...inputs: Parameters<Svc["handler"]>
    ) => Effect.Effect<Awaited<ReturnType<Svc["handler"]>>, Err, Req>,
  ) =>
  <Stmt extends Statement = Statement>() =>
    Object.assign(
      Effect.gen(function* () {
        return handler as (
          ...inputs: Parameters<Svc["handler"]>
        ) => Effect.Effect<Awaited<ReturnType<Svc["handler"]>>, Err>;
      }),
      {
        type: svc.type,
        id,
        handler: handler,
        binding: svc.stmt as Stmt,
        Req: undefined! as Req,
      } as const,
    ) satisfies Service<Svc["type"], ID, Svc["handler"], Err, Req, Stmt>;

export type Service<
  Type extends string = any,
  ID extends string = any,
  Contract extends (...inputs: any[]) => any = any,
  Err = unknown,
  Req = unknown,
  // Attributes extends S.Struct.Fields,
  Stmt extends Statement = Statement,
> = Effect.Effect<
  (
    ...inputs: Parameters<Contract>
  ) => Effect.Effect<Awaited<ReturnType<Contract>>, Err>,
  never,
  Req
> & {
  type: Type;
  id: ID;
  // attributes: Attributes;
  handler: (
    ...inputs: Parameters<Contract>
  ) => Effect.Effect<Awaited<ReturnType<Contract>>, Err, Req>;
  /** @internal */
  binding: Stmt;
  /** @internal */
  Req: Req;
};
