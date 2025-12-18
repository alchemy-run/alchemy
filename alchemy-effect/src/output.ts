import { pipe } from "effect";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as App from "./app.ts";
import { isPrimitive } from "./data.ts";
import type { From } from "./policy.ts";
import { getRefMetadata, isRef, ref as stageRef, type Ref } from "./ref.ts";
import type { AnyResource, Resource } from "./resource.ts";
import * as State from "./state.ts";
import type { IsAny, UnionToIntersection } from "./util.ts";

// a special symbol only used at runtime to probe the Output proxy
const ExprSymbol = Symbol.for("alchemy/Expr");

export const isOutput = (value: any): value is Output<any> =>
  value &&
  (typeof value === "object" || typeof value === "function") &&
  ExprSymbol in value;

export const of = <R extends Resource>(
  resource: Ref<R> | R,
): Output.Of<R["attr"], From<R>> => {
  if (isRef(resource)) {
    const metadata = getRefMetadata(resource);
    return new RefExpr(
      metadata.stack,
      metadata.stage,
      metadata.resourceId,
    ) as any;
  }
  return new ResourceExpr(resource) as any;
};

export const ref = <R extends Resource<string, string, any, any>>(
  resourceId: R["id"],
  options?: {
    stage?: string;
    stack?: string;
  },
) => of(stageRef({ resourceId, ...options }));

export interface Output<A = any, Src extends Resource = any, Req = any> {
  readonly kind: string;
  readonly src: Src;
  readonly req: Req;
  apply<B>(fn: (value: A) => B): Output.Of<B, Src, Req>;
  effect<B, Req2>(
    // Outputs are not allowed to fail, so we use never for the error type
    fn: (value: A) => Effect.Effect<B, never, Req2>,
  ): Output.Of<B, Src, Req | Req2>;
}

export declare namespace Output {
  // TODO(sam): doesn't support disjunct unions very well
  export type Of<A, Src extends Resource = any, Req = never> = [
    Extract<A, object>,
  ] extends [never]
    ? Output<A, Src, Req>
    : [Extract<A, any[]>] extends [never]
      ? Object<
          {
            [attr in keyof A]: A[attr];
          },
          Src,
          Req
        >
      : Array<Extract<A, any[]>, Src, Req>;
}

export type Object<A, Src extends Resource, Req = any> = Output<A, Src, Req> & {
  [Prop in keyof Exclude<A, undefined>]-?: Output.Of<
    Exclude<A, undefined>[Prop] | Extract<A, undefined>,
    Src,
    Req
  >;
};

export type Array<A extends any[], Src extends Resource, Req = any> = Output<
  A,
  Src,
  Req
> & {
  [i in Extract<keyof A, number>]: Output.Of<A[i], Src, Req>;
};

export const isExpr = (value: any): value is Expr<any> =>
  value &&
  (typeof value === "object" || typeof value === "function") &&
  ExprSymbol in value;

export type Expr<A = any, Src extends AnyResource = AnyResource, Req = any> =
  | AllExpr<Expr<A, Src, Req>[]>
  | ApplyExpr<any, A, Src, Req>
  | EffectExpr<any, A, Src, Req>
  | LiteralExpr<A>
  | PropExpr<A, keyof A, Src, Req>
  | ResourceExpr<A, Src, Req>
  | RefExpr<A>;

const proxy = (self: any): any => {
  const proxy = new Proxy(
    Object.assign(() => {}, self),
    {
      has: (_, prop) => (prop === ExprSymbol ? true : prop in self),
      get: (_, prop) =>
        prop === Symbol.toPrimitive
          ? (hint: string) => (hint === "string" ? self.toString() : self)
          : prop === ExprSymbol
            ? self
            : isResourceExpr(self) && self.stables && prop in self.stables
              ? self.stables[prop as keyof typeof self.stables]
              : prop === "apply"
                ? self[prop]
                : prop in self
                  ? typeof self[prop as keyof typeof self] === "function" &&
                    !("kind" in self)
                    ? new PropExpr(proxy, prop as never)
                    : self[prop as keyof typeof self]
                  : new PropExpr(proxy, prop as never),
      apply: (_, thisArg, args) => {
        if (isPropExpr(self)) {
          if (self.identifier === "apply") {
            return new ApplyExpr(self.expr, args[0]);
          } else if (self.identifier === "effect") {
            return new EffectExpr(self.expr, args[0]);
          }
        }
        return undefined;
      },
    },
  );
  return proxy;
};

export abstract class BaseExpr<A = any, Src extends Resource = any, Req = any>
  implements Output<A, Src, Req>
{
  declare readonly kind: any;
  declare readonly src: Src;
  declare readonly req: Req;
  // we use a kind tag instead of instanceof to protect ourselves from duplicate alchemy-effect module imports
  constructor() {}
  public apply<B>(fn: (value: A) => B): Output.Of<B, Src> {
    return new ApplyExpr(this as Expr<A, Src, Req>, fn) as any;
  }
  public effect<B, Req2>(
    fn: (value: A) => Effect.Effect<B, never, Req2>,
  ): Output.Of<B, Src, Req | Req2> {
    return new EffectExpr(this as any, fn) as any;
  }
  public pipe(...fns: any[]): any {
    // @ts-expect-error
    return pipe(this, ...fns);
  }
  toString(): string {
    return JSON.stringify(this, null, 2);
  }
}

export const isResourceExpr = <
  Value = any,
  Src extends AnyResource = AnyResource,
  Req = any,
>(
  node: Expr<Value, Src, Req> | any,
): node is ResourceExpr<Value, Src, Req> => node?.kind === "ResourceExpr";

export class ResourceExpr<
  Value,
  Src extends AnyResource,
  Req = never,
> extends BaseExpr<Value, Src, Req> {
  readonly kind = "ResourceExpr";
  constructor(
    public readonly src: Src,
    readonly stables?: Record<string, any>,
  ) {
    super();
    return proxy(this);
  }
}

export const isPropExpr = <
  A = any,
  Prop extends keyof A = keyof A,
  Src extends AnyResource = AnyResource,
  Req = any,
>(
  node: any,
): node is PropExpr<A, Prop, Src, Req> => node?.kind === "PropExpr";

export class PropExpr<
  A = any,
  Id extends keyof A = keyof A,
  Src extends AnyResource = AnyResource,
  Req = any,
> extends BaseExpr<A[Id], Src, Req> {
  readonly kind = "PropExpr";
  constructor(
    public readonly expr: Expr<A, Src, Req>,
    public readonly identifier: Id,
  ) {
    super();
    return proxy(this);
  }
}

export const literal = <A>(value: A) => new LiteralExpr(value);

export const isLiteralExpr = <A = any>(node: any): node is LiteralExpr<A> =>
  node?.kind === "LiteralExpr";

export class LiteralExpr<A> extends BaseExpr<A, never> {
  readonly kind = "LiteralExpr";
  constructor(public readonly value: A) {
    super();
    return proxy(this);
  }
}

//Output.ApplyExpr<any, any, AnyResource, any>
export const isApplyExpr = <
  In = any,
  Out = any,
  Src extends AnyResource = AnyResource,
  Req = any,
>(
  node: Output<Out, Src, Req>,
): node is ApplyExpr<In, Out, Src, Req> => node?.kind === "ApplyExpr";

export class ApplyExpr<
  A,
  B,
  Src extends AnyResource,
  Req = never,
> extends BaseExpr<B, Src, Req> {
  readonly kind = "ApplyExpr";
  constructor(
    public readonly expr: Expr<A, Src, Req>,
    public readonly f: (value: A) => B,
  ) {
    super();
    return proxy(this);
  }
}

export const isEffectExpr = <
  In = any,
  Out = any,
  Src extends AnyResource = AnyResource,
  Req = any,
  Req2 = any,
>(
  node: any,
): node is EffectExpr<In, Out, Src, Req, Req2> => node?.kind === "EffectExpr";

export class EffectExpr<
  A,
  B,
  Src extends AnyResource,
  Req = never,
  Req2 = never,
> extends BaseExpr<B, Src, Req> {
  readonly kind = "EffectExpr";
  constructor(
    public readonly expr: Expr<A, Src, Req>,
    public readonly f: (value: A) => Effect.Effect<B, never, Req2>,
  ) {
    super();
    return proxy(this);
  }
}

export const isAllExpr = <Outs extends Expr[] = Expr[]>(
  node: any,
): node is AllExpr<Outs> => node?.kind === "AllExpr";

export class AllExpr<Outs extends Expr[]> extends BaseExpr<Outs> {
  readonly kind = "AllExpr";
  constructor(public readonly outs: Outs) {
    super();
    return proxy(this);
  }
}

export const isRefExpr = <A = any>(node: any): node is RefExpr<A> =>
  node?.kind === "RefExpr";

export class RefExpr<A> extends BaseExpr<A, never, never> {
  readonly kind = "RefExpr";
  constructor(
    public readonly stack: string | undefined,
    public readonly stage: string | undefined,
    public readonly resourceId: string,
  ) {
    super();
    return proxy(this);
  }
}

export class MissingSourceError extends Data.TaggedError("MissingSourceError")<{
  message: string;
  srcId: string;
}> {}

export class InvalidReferenceError extends Data.TaggedError(
  "InvalidReferenceError",
)<{
  message: string;
  stack: string;
  stage: string;
  resourceId: string;
}> {}

export const evaluate: <A, Upstream extends AnyResource, Req>(
  expr: Output<A, Upstream, Req>,
  upstream: {
    [Id in Upstream["id"]]: Extract<Upstream, { id: Id }>["attr"];
  },
) => Effect.Effect<
  A,
  InvalidReferenceError | MissingSourceError,
  State.State
> = (expr, upstream) =>
  Effect.gen(function* () {
    if (isResourceExpr(expr)) {
      const srcId = expr.src.id;
      const src = upstream[srcId as keyof typeof upstream];
      if (!src) {
        // type-safety should prevent this but let the caller decide how to handle it
        return yield* Effect.fail(
          new MissingSourceError({
            message: `Source ${srcId} not found`,
            srcId,
          }),
        );
      }
      return src;
    } else if (isLiteralExpr(expr)) {
      return expr.value;
    } else if (isApplyExpr(expr)) {
      return expr.f(yield* evaluate(expr.expr, upstream));
    } else if (isEffectExpr(expr)) {
      // TODO(sam): the same effect shoudl be memoized so that it's not run multiple times
      return yield* expr.f(yield* evaluate(expr.expr, upstream));
    } else if (isAllExpr(expr)) {
      return yield* Effect.all(expr.outs.map((out) => evaluate(out, upstream)));
    } else if (isPropExpr(expr)) {
      return (yield* evaluate(expr.expr, upstream))?.[expr.identifier];
    } else if (isRefExpr(expr)) {
      const state = yield* State.State;
      const app = yield* App.App;
      const stack = expr.stack ?? app.name;
      const stage = expr.stage ?? app.stage;
      const resource = yield* state.get({
        stack,
        stage,
        resourceId: expr.resourceId,
      });
      if (!resource) {
        return yield* Effect.fail(
          new InvalidReferenceError({
            message: `Reference to '${expr.resourceId}' in stack '${stack}' and stage '${stage}' not found. Have you deployed '${stage}' or '${stack}'?`,
            stack,
            stage,
            resourceId: expr.resourceId,
          }),
        );
      }
      return resource.attr;
    } else if (Array.isArray(expr)) {
      return yield* Effect.all(expr.map((item) => evaluate(item, upstream)));
    } else if (typeof expr === "object" && expr !== null) {
      return Object.fromEntries(
        yield* Effect.all(
          Object.entries(expr).map(([key, value]) =>
            evaluate(value, upstream).pipe(Effect.map((value) => [key, value])),
          ),
        ),
      );
    }
    return expr;
  }) as Effect.Effect<any>;

export type Upstream<O extends Output<any, any, any>> =
  O extends Output<infer _V, infer Up, infer _Req>
    ? {
        [Id in Up["id"]]: Extract<Up, { id: Id }>;
      }
    : never;

export const hasOutputs = (value: any): value is Output<any, any, any> =>
  Object.keys(upstreamAny(value)).length > 0;

export const upstreamAny = (
  value: any,
): {
  [ID in string]: Resource;
} => {
  if (isExpr(value)) {
    return upstream(value);
  } else if (Array.isArray(value)) {
    return Object.assign({}, ...value.map(resolveUpstream));
  } else if (
    value &&
    (typeof value === "object" || typeof value === "function")
  ) {
    return Object.assign(
      {},
      ...Object.values(value).map((value) => resolveUpstream(value)),
    );
  }
  return {};
};

export const upstream = <E extends Output<any, AnyResource, any>>(
  expr: E,
): {
  [Id in keyof Upstream<E>]: Upstream<E>[Id];
} => _upstream(expr);

const _upstream = (expr: any): any => {
  if (isResourceExpr(expr)) {
    return {
      [expr.src.id]: expr.src,
    };
  } else if (isPropExpr(expr)) {
    return upstream(expr.expr);
  } else if (isAllExpr(expr)) {
    return Object.assign({}, ...expr.outs.map((out) => upstream(out)));
  } else if (isEffectExpr(expr) || isApplyExpr(expr)) {
    return upstream(expr.expr);
  } else if (Array.isArray(expr)) {
    return expr.map(_upstream).reduce(toObject, {});
  } else if (typeof expr === "object" && expr !== null) {
    return Object.values(expr)
      .map((v) => _upstream(v))
      .reduce(toObject, {});
  }
  return {};
};

const toObject = <A, B>(acc: B, v: A) => ({
  ...acc,
  ...v,
});

export type ResolveUpstream<A> = unknown extends A
  ? { [id: string]: Resource }
  : A extends undefined | null | boolean | number | string | symbol | bigint
    ? {}
    : IsAny<A> extends true
      ? {}
      : A extends Output<any, infer Upstream, any>
        ? {
            [Id in Upstream["id"]]: Extract<Upstream, { id: Id }>;
          }
        : A extends readonly any[] | any[]
          ? ResolveUpstream<A[number]>
          : A extends Record<string, any>
            ? {
                [Id in keyof UnionToIntersection<
                  ResolveUpstream<A[keyof A]>
                >]: UnionToIntersection<ResolveUpstream<A[keyof A]>>[Id];
              }
            : {};

export const resolveUpstream = <const A>(value: A): ResolveUpstream<A> => {
  if (isPrimitive(value)) {
    return {} as any;
  } else if (isOutput(value)) {
    return upstream(value) as any;
  } else if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((v) => resolveUpstream(v)).flatMap(Object.entries),
    ) as any;
  } else if (typeof value === "object" || typeof value === "function") {
    return Object.fromEntries(
      Object.values(value as any)
        .map(resolveUpstream)
        .flatMap(Object.entries),
    ) as any;
  }
  return {} as any;
};

export const interpolate = <Args extends any[]>(
  template: TemplateStringsArray,
  ...args: Args
): All<Args> extends Output<any, infer Src, infer Req>
  ? Output<string, Src, Req>
  : never =>
  all(...args.map((arg) => (isOutput(arg) ? arg : literal(arg)))).apply(
    (args) =>
      template
        .map((str, i) => str + (args[i] == null ? "" : String(args[i])))
        .join(""),
  ) as any;

export const all = <Outs extends (Output | Expr)[]>(...outs: Outs) =>
  new AllExpr(outs as any) as unknown as All<Outs>;

export type All<Outs extends (Output | Expr)[]> = number extends Outs["length"]
  ? [Outs[number]] extends [
      | Output<infer V, infer Src, infer Req>
      | Expr<infer V, infer Src, infer Req>,
    ]
    ? Output<V, Src, Req>
    : never
  : Tuple<Outs>;

export type Tuple<
  Outs extends (Output | Expr)[],
  Values extends any[] = [],
  Src extends Resource = never,
  Req = never,
> = Outs extends [infer H, ...infer Tail extends (Output | Expr)[]]
  ? H extends Output<infer V, infer Src2, infer Req2>
    ? Tuple<Tail, [...Values, V], Src | Src2, Req | Req2>
    : never
  : Output<Values, Src, Req>;

export const filter = <Outs extends any[]>(...outs: Outs) =>
  outs.filter(isOutput) as unknown as Filter<Outs>;

export type Filter<Outs extends any[]> = number extends Outs["length"]
  ? Output<
      Extract<Outs[number], Output>["value"],
      Extract<Outs[number], Output>["src"],
      Extract<Outs[number], Output>["req"]
    >
  : FilterTuple<Outs>;

export type FilterTuple<
  Outs extends (Output | Expr)[],
  Values extends any[] = [],
  Src extends Resource = never,
> = Outs extends [infer H, ...infer Tail extends (Output | Expr)[]]
  ? H extends Output<infer V, infer Src2>
    ? FilterTuple<Tail, [...Values, V], Src | Src2>
    : FilterTuple<Tail, Values, Src>
  : Output<Values, Src>;
