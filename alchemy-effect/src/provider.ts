import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { ScopedPlanStatusSession } from "./cli/service.ts";
import type { Diff } from "./diff.ts";
import type { Input } from "./input.ts";
import type { Resource } from "./resource.ts";
import type { Runtime } from "./runtime.ts";
import type { Service } from "./service.ts";

export interface Provider<
  R extends Resource | Service,
> extends Context.TagClass<
  Provider<R>,
  R["type"],
  ProviderService<any>
  // TODO(sam): we are using any here because the R["type"] is enough and gaining access to the sub type (e.g. SQS.Queue)
  // is currently not possible in the current approach

  // preferred:
  // ProviderService<R>
> {}

type BindingData<Res extends Resource> = [Res] extends [Runtime]
  ? Res["binding"][]
  : any[];

type Props<Res extends Resource> = Input.ResolveOpaque<Res["props"]>;

export interface ProviderService<
  Res extends Resource = Resource,
  ReadReq = never,
  DiffReq = never,
  PrecreateReq = never,
  CreateReq = never,
  UpdateReq = never,
  DeleteReq = never,
> {
  /**
   * The version of the provider.
   *
   * @default 0
   */
  version?: number;
  // tail();
  // watch();
  // replace(): Effect.Effect<void, never, never>;
  // different interface that is persistent, watching, reloads
  // run?() {}
  read?(input: {
    id: string;
    instanceId: string;
    olds: Props<Res>;
    // what is the ARN?
    output: Res["attr"] | undefined; // current state -> synced state
    bindings: BindingData<Res>;
  }): Effect.Effect<Res["attr"] | undefined, any, ReadReq>;
  /**
   * Properties that are always stable across any update.
   */
  stables?: Extract<keyof Res["attr"], string>[];
  diff?(input: {
    id: string;
    olds: Props<Res>;
    instanceId: string;
    // Note: we do not resolve (Props<Res>) here because diff runs during plan
    // -> we need a way for the diff handlers to work with Outputs
    news: Res["props"];
    output: Res["attr"];
  }): Effect.Effect<Diff | void, never, DiffReq>;
  precreate?(input: {
    id: string;
    news: Props<Res>;
    instanceId: string;
    session: ScopedPlanStatusSession;
  }): Effect.Effect<Res["attr"], any, PrecreateReq>;
  create(input: {
    id: string;
    instanceId: string;
    news: Props<Res>;
    session: ScopedPlanStatusSession;
    bindings: BindingData<Res>;
  }): Effect.Effect<Res["attr"], any, CreateReq>;
  update(input: {
    id: string;
    instanceId: string;
    news: Props<Res>;
    olds: Props<Res>;
    output: Res["attr"];
    session: ScopedPlanStatusSession;
    bindings: BindingData<Res>;
  }): Effect.Effect<Res["attr"], any, UpdateReq>;
  delete(input: {
    id: string;
    instanceId: string;
    olds: Props<Res>;
    output: Res["attr"];
    session: ScopedPlanStatusSession;
    bindings: BindingData<Res>;
  }): Effect.Effect<void, any, DeleteReq>;
}

export const getProviderByType = Effect.fnUntraced(function* (
  resourceType: string,
) {
  const context = yield* Effect.context<never>();
  const provider: ProviderService = context.unsafeMap.get(resourceType);
  if (!provider) {
    return yield* Effect.die(
      new Error(`Provider not found for ${resourceType}`),
    );
  }
  return provider;
});
