import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ComponentType } from "react";
import type { ResourceLike } from "../Resource.ts";
import type { ResourceStatus } from "../State/ResourceState.ts";

/**
 * UIProvider is the dashboard counterpart of {@link Provider}: where a
 * `Provider` implements a resource's lifecycle operations, a `UIProvider`
 * implements how the resource *renders* in the alchemy dashboard — its icon,
 * accent color, category, one-line summary, key facts, console deep link, and
 * (for flagship resources) custom canvas-card and detail-page components.
 *
 * UIProviders are aggregated exactly like lifecycle providers: each service
 * exposes a `ui()` Layer, clouds merge their services' layers, and the
 * dashboard SPA builds one merged Layer into a {@link UIRegistry}.
 *
 * IMPORTANT — browser safety: UIProvider modules are bundled into the
 * dashboard web app. They must only import `effect/*` and types. Reference
 * resource types with `import type` and key the tag by the type *string*:
 *
 * ```ts
 * import type { Bucket } from "./Bucket.ts";
 * export const BucketUI = UIProvider.succeed<Bucket>("AWS.S3.Bucket", {
 *   displayName: "S3 Bucket",
 *   icon: "cylinder",
 *   category: "storage",
 *   summary: (ctx) => ctx.attrs?.bucketName,
 * });
 * ```
 */
export interface UIProvider<
  R extends ResourceLike = ResourceLike,
> extends Effect.Effect<UIProviderService<R>, never, UIProvider<R>> {
  asEffect: () => Effect.Effect<UIProviderService<R>, never, UIProvider<R>>;
  [Symbol.iterator]: () => Effect.EffectIterator<UIProvider<R>>;
  of: (service: UIProviderService<R>) => UIProviderService<R>;
}

/**
 * Prefix used to namespace UIProvider tags so they never collide with the
 * lifecycle {@link Provider} tags, which are keyed by the bare type string.
 */
const keyOf = (type: string) => `UI(${type})`;

export const UIProvider = <R extends ResourceLike>(
  type: R["Type"],
): UIProvider<R> =>
  Context.Service<UIProvider<R>, UIProviderService<R>>()(keyOf(type)) as any;

/**
 * Coarse grouping used for filtering and default styling in the dashboard.
 */
export type UICategory =
  | "compute"
  | "storage"
  | "database"
  | "network"
  | "dns"
  | "queue"
  | "eventing"
  | "ai"
  | "auth"
  | "security"
  | "observability"
  | "cdn"
  | "email"
  | "media"
  | "config"
  | "billing"
  | "other";

/**
 * A key/value fact rendered in the inspector panel and the default detail
 * page. Values are read from persisted state, so they may be `undefined`
 * until the resource has been deployed.
 */
export interface UIFact {
  label: string;
  value: string | number | boolean | undefined;
  /** Render the value in monospace (ids, ARNs, hashes). */
  mono?: boolean;
  /** Render the value as an external link. */
  href?: string;
  /** Show a copy-to-clipboard affordance. */
  copy?: boolean;
}

/**
 * Everything the dashboard knows about one resource instance, passed to every
 * UIProvider callback. `props`/`attrs` come from the persisted state and may
 * be absent for resources that have not been deployed yet — always use
 * optional chaining.
 */
export interface ResourceUIContext<R extends ResourceLike = ResourceLike> {
  fqn: string;
  logicalId: string;
  type: R["Type"];
  status: ResourceStatus;
  stack: string;
  stage: string;
  /** Persisted (resolved) input properties. */
  props?: Record<string, any>;
  /** Persisted output attributes. */
  attrs?: Partial<R["Attributes"]>;
  /** Bindings attached to this resource (it is the host). */
  bindings: { sid: string; data: any }[];
  /** FQNs of resources that depend on this one. */
  downstream: string[];
}

export interface UIProviderService<R extends ResourceLike = ResourceLike> {
  /**
   * Short human name, e.g. "S3 Bucket". Defaults to the last segment of the
   * resource type.
   */
  displayName?: string;
  /**
   * Icon: a lucide-react icon name in kebab-case (e.g. "database",
   * "hard-drive") or a custom component for brand icons.
   */
  icon?: string | ComponentType<{ size?: number; color?: string }>;
  /** Accent color (hex) used for the icon and node tint. */
  color?: string;
  /** Coarse grouping used for filtering + default colors. */
  category?: UICategory;
  /** One-line node subtitle, e.g. the physical name. */
  summary?: (ctx: ResourceUIContext<R>) => string | undefined;
  /**
   * Primary external URL for the resource itself (workers.dev URL, Lambda
   * function URL, hostname, ...).
   */
  link?: (ctx: ResourceUIContext<R>) => string | undefined;
  /** Deep link into the cloud provider's web console. */
  consoleUrl?: (ctx: ResourceUIContext<R>) => string | undefined;
  /** Key/value facts for the inspector and default detail page. */
  facts?: (ctx: ResourceUIContext<R>) => UIFact[];
  /** Custom canvas-node card body (flagship resources only). */
  Card?: ComponentType<{ ctx: ResourceUIContext<R> }>;
  /** Custom full detail page (flagship resources only). */
  Details?: ComponentType<{ ctx: ResourceUIContext<R> }>;
}

/**
 * Provide a UIProvider eagerly, mirroring `Provider.succeed`.
 *
 * ```ts
 * export const QueueUI = UIProvider.succeed<Queue>("AWS.SQS.Queue", {
 *   displayName: "SQS Queue",
 *   icon: "list-ordered",
 *   category: "queue",
 * });
 * ```
 */
export const succeed = <R extends ResourceLike>(
  type: R["Type"],
  service: UIProviderService<R>,
): Layer.Layer<UIProvider<R>> =>
  Layer.succeed(UIProvider<R>(type) as any, service) as Layer.Layer<
    UIProvider<R>
  >;

/**
 * Provide a UIProvider from an Effect, mirroring `Provider.effect`. Useful
 * when construction needs other services from the UI layer graph.
 */
export const effect = <R extends ResourceLike, Req = never>(
  type: R["Type"],
  eff: Effect.Effect<UIProviderService<R>, never, Req>,
): Layer.Layer<UIProvider<R>, never, Req> =>
  Layer.effect(UIProvider<R>(type) as any, eff) as Layer.Layer<
    UIProvider<R>,
    never,
    Req
  >;

/**
 * The registry the dashboard app resolves node renderers from. Built once at
 * startup from the merged UI layer of every cloud.
 */
export interface UIRegistry {
  readonly providers: ReadonlyMap<string, UIProviderService>;
  get(type: string): UIProviderService | undefined;
}

/**
 * Build a {@link UIRegistry} from a merged Layer of UIProviders. UIProvider
 * services are plain objects with no finalizers, so the build scope is closed
 * immediately after the context is materialized.
 */
export const buildRegistry = (
  layer: Layer.Layer<any, never, never>,
): Effect.Effect<UIRegistry> =>
  Effect.scoped(
    Effect.gen(function* () {
      const context: Context.Context<never> = yield* Layer.build(layer);
      const providers = new Map<string, UIProviderService>();
      for (const [key, value] of (context as any).mapUnsafe as Map<
        string,
        unknown
      >) {
        if (
          typeof key === "string" &&
          key.startsWith("UI(") &&
          key.endsWith(")")
        ) {
          providers.set(key.slice(3, -1), value as UIProviderService);
        }
      }
      return {
        providers,
        get: (type: string) => providers.get(type),
      } satisfies UIRegistry;
    }),
  );
