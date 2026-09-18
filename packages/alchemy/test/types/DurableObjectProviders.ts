import * as Celld from "@/Celld/index.ts";
import * as Cloudflare from "@/Cloudflare/Workers/index.ts";
import {
  getWorkerExport,
  handleRpcExit,
  type DurableObjectBridgeOptions,
  type WorkerBuild,
} from "@/Cloudflare/index.ts";
import * as Rivet from "@/Rivet/index.ts";
import type { RuntimeContext } from "@/RuntimeContext.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

export const _getWorkerExport: typeof Cloudflare.getWorkerExport =
  getWorkerExport;
export const _handleRpcExit: typeof Cloudflare.handleRpcExit = handleRpcExit;
export type PublicWorkerBuild = WorkerBuild<unknown>;
export type PublicDurableObjectBridgeOptions = DurableObjectBridgeOptions;

class Dependency extends Context.Service<
  Dependency,
  { readonly value: number }
>()("DurableObjectTypeDependency") {}

interface CounterShape {
  get(): Effect.Effect<number | undefined, never, RuntimeContext>;
}

class CelldCounter extends Celld.DurableObject<CelldCounter, CounterShape>()(
  "Counter",
) {}
class CloudflareCounter extends Cloudflare.DurableObject<
  CloudflareCounter,
  CounterShape
>()("Counter") {}
class RivetCounter extends Rivet.DurableObject<RivetCounter, CounterShape>()(
  "Counter",
) {}

export const celldLive = CelldCounter.make(
  Effect.gen(function* () {
    const state = yield* Celld.DurableObjectState;
    yield* Dependency;
    return Effect.succeed({ get: () => state.storage.get<number>("count") });
  }),
);

export const cloudflareLive = CloudflareCounter.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    yield* Dependency;
    return Effect.succeed({ get: () => state.storage.get<number>("count") });
  }),
);

export const rivetLive = RivetCounter.make(
  Effect.gen(function* () {
    const state = yield* Rivet.DurableObjectState;
    yield* Dependency;
    return Effect.succeed({ get: () => state.storage.get<number>("count") });
  }),
);

export const _celldRequirements: Layer.Layer<
  CelldCounter,
  never,
  Celld.CelldWorker | Dependency
> = celldLive;
export const _cloudflareRequirements: Layer.Layer<
  CloudflareCounter,
  never,
  Cloudflare.Worker | Dependency
> = cloudflareLive;
export const _rivetRequirements: Layer.Layer<
  RivetCounter,
  never,
  Rivet.RivetWorker | Dependency
> = rivetLive;

// @ts-expect-error An unrelated init service must remain a layer requirement.
export const _missingCelldDependency: Layer.Layer<
  CelldCounter,
  never,
  Celld.CelldWorker
> = celldLive;
// @ts-expect-error An unrelated init service must remain a layer requirement.
export const _missingCloudflareDependency: Layer.Layer<
  CloudflareCounter,
  never,
  Cloudflare.Worker
> = cloudflareLive;
// @ts-expect-error An unrelated init service must remain a layer requirement.
export const _missingRivetDependency: Layer.Layer<
  RivetCounter,
  never,
  Rivet.RivetWorker
> = rivetLive;

export const celldBound = CelldCounter.pipe(Effect.provide(celldLive));
export const rivetBound = RivetCounter.pipe(Effect.provide(rivetLive));
export const _celldBoundRequirements: Effect.Effect<
  Celld.DurableObject<CelldCounter>,
  never,
  Celld.CelldWorker | Dependency
> = celldBound;
export const _rivetBoundRequirements: Effect.Effect<
  Rivet.DurableObject<RivetCounter>,
  never,
  Rivet.RivetWorker | Dependency
> = rivetBound;

export const wrongState = CelldCounter.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.succeed({ get: () => state.storage.get<number>("count") });
  }),
);
export const _wrongStatePreserved: Layer.Layer<
  CelldCounter,
  never,
  Celld.CelldWorker | Cloudflare.DurableObjectState
> = wrongState;
// @ts-expect-error Celld does not supply the Cloudflare state service.
export const _wrongStateConsumed: Layer.Layer<
  CelldCounter,
  never,
  Celld.CelldWorker
> = wrongState;

// @ts-expect-error Same-named declarations from different providers remain distinct.
export const _wrongImplementation: Layer.Layer<
  CelldCounter,
  never,
  Cloudflare.Worker | Dependency
> = cloudflareLive;
// @ts-expect-error Same-named declarations cannot satisfy a Cloudflare class either.
export const _wrongCloudflareImplementation: Layer.Layer<
  CloudflareCounter,
  never,
  Celld.CelldWorker | Dependency
> = celldLive;

export class InlineCelld extends Celld.DurableObject<InlineCelld>()(
  "InlineCelld",
  Effect.gen(function* () {
    const state = yield* Celld.DurableObjectState;
    yield* Dependency;
    return Effect.succeed({ get: () => state.storage.get<number>("count") });
  }),
) {}

export class InlineCloudflare extends Cloudflare.DurableObject<InlineCloudflare>()(
  "InlineCloudflare",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    yield* Dependency;
    return Effect.succeed({ get: () => state.storage.get<number>("count") });
  }),
) {}

export class InlineRivet extends Rivet.DurableObject<InlineRivet>()(
  "InlineRivet",
  Effect.gen(function* () {
    const state = yield* Rivet.DurableObjectState;
    yield* Dependency;
    return Effect.succeed({ get: () => state.storage.get<number>("count") });
  }),
) {}

export const _inlineCelld: Effect.Effect<
  Celld.DurableObject<InlineCelld>,
  never,
  Celld.CelldWorker | Dependency
> = InlineCelld;
export const _inlineCloudflare: Effect.Effect<
  Cloudflare.DurableObject<InlineCloudflare>,
  never,
  Cloudflare.Worker | Dependency
> = InlineCloudflare;
export const _inlineRivet: Effect.Effect<
  Rivet.DurableObject<InlineRivet>,
  never,
  Rivet.RivetWorker | Dependency
> = InlineRivet;
// @ts-expect-error Inline declarations also preserve unrelated requirements.
export const _inlineDependencyLost: Effect.Effect<
  Rivet.DurableObject<InlineRivet>,
  never,
  Rivet.RivetWorker
> = InlineRivet;

export const directRivet = Rivet.DurableObject(
  "DirectRivet",
  Effect.gen(function* () {
    const state = yield* Rivet.DurableObjectState;
    yield* Dependency;
    return { get: () => state.storage.get<number>("count") };
  }),
);
export const _directRivet: Effect.Effect<
  Rivet.DurableObject<CounterShape>,
  never,
  Rivet.RivetWorker | Dependency
> = directRivet;

Rivet.DurableObject<RivetCounter, CounterShape>()("Foreign", {
  // @ts-expect-error Rivet has no Cloudflare class-transfer option.
  transferredFrom: "old",
});
Celld.DurableObject<CelldCounter, CounterShape>()("Foreign", {
  // @ts-expect-error Celld declarations do not bind foreign Cloudflare scripts.
  scriptName: "old",
});
// @ts-expect-error Rivet actors have no HTTP fetch handler.
Rivet.DurableObject("FetchActor", Effect.succeed({ fetch: Effect.void }));

declare const rivetNamespace: Rivet.DurableObject<CounterShape>;
declare const celldNamespace: Celld.DurableObject<CounterShape>;
declare const cloudflareNamespace: Cloudflare.DurableObject<CounterShape>;
declare const rivetState: Rivet.DurableObjectState["Service"];
declare const celldState: Celld.DurableObjectState["Service"];
declare const cloudflareState: Cloudflare.DurableObjectState["Service"];

cloudflareNamespace.getByName("counter", { locationHint: "wnam" });
// @ts-expect-error Rivet does not advertise Cloudflare placement hints.
rivetNamespace.getByName("counter", { locationHint: "wnam" });
// @ts-expect-error Celld does not advertise unverified placement hints.
celldNamespace.getByName("counter", { locationHint: "wnam" });
// @ts-expect-error Rivet has no Cloudflare namespace id.
rivetNamespace.namespaceId;
// @ts-expect-error Celld has no Cloudflare namespace id.
celldNamespace.namespaceId;

cloudflareState.container;
cloudflareState.storage.getCurrentBookmark();
export const _nativeCelldContainerStart:
  | ((options?: Celld.Containers.ContainerStartupOptions) => void)
  | undefined = celldState.container?.start;
// @ts-expect-error Celld does not advertise unverified storage bookmarks.
celldState.storage.getCurrentBookmark();
// @ts-expect-error Rivet does not implement workerd input gates.
rivetState.blockConcurrencyWhile;
// @ts-expect-error Rivet does not impersonate workerd transactions.
rivetState.storage.transaction;
// @ts-expect-error Rivet does not implement synchronous workerd KV.
rivetState.storage.kv;
// @ts-expect-error Runtime storage operations cannot run during planning.
export const _uncoloredCelldStorage: Effect.Effect<unknown> =
  celldState.storage.get("count");
// @ts-expect-error Runtime storage operations cannot run during planning.
export const _uncoloredRivetStorage: Effect.Effect<unknown> =
  rivetState.storage.get("count");
