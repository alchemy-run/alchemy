import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ScopedPlanStatusSession } from "./apply.ts";
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

export interface ProviderService<Res extends Resource = Resource> {
  // tail();
  // watch();
  // replace(): Effect.Effect<void, never, never>;
  // different interface that is persistent, watching, reloads
  // run?() {}
  read?(input: {
    id: string;
    olds: Props<Res> | undefined;
    // what is the ARN?
    output: Res["attr"] | undefined; // current state -> synced state
    session: ScopedPlanStatusSession;
    bindings: BindingData<Res>;
  }): Effect.Effect<Res["attr"] | undefined, any, never>;
  diff?(input: {
    id: string;
    olds: Props<Res>;
    // Note: we do not resolve (Props<Res>) here because diff runs during plan
    // -> we need a way for the diff handlers to work with Outputs
    news: Res["props"];
    output: Res["attr"];
  }): Effect.Effect<Diff | void, never, never>;
  precreate?(input: {
    id: string;
    news: Props<Res>;
    session: ScopedPlanStatusSession;
  }): Effect.Effect<Res["attr"], any, never>;
  create(input: {
    id: string;
    news: Props<Res>;
    session: ScopedPlanStatusSession;
    bindings: BindingData<Res>;
  }): Effect.Effect<Res["attr"], any, never>;
  update(input: {
    id: string;
    news: Props<Res>;
    olds: Props<Res>;
    output: Res["attr"];
    session: ScopedPlanStatusSession;
    bindings: BindingData<Res>;
  }): Effect.Effect<Res["attr"], any, never>;
  delete(input: {
    id: string;
    olds: Props<Res>;
    output: Res["attr"];
    session: ScopedPlanStatusSession;
    bindings: BindingData<Res>;
  }): Effect.Effect<void, any, never>;
}
