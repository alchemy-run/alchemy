import type * as ConfigError from "effect/Config";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { InputProps } from "../Input.ts";
import type { Named, Tag } from "../Named.ts";
import type { Main, MakeShape, PlatformServices } from "../Platform.ts";
import type { Rpc } from "../Rpc.ts";
import { Host } from "./Process.ts";
import { Service, type ServiceProps } from "./Service.ts";

/**
 * Props for {@link Vite}: everything a {@link Service} takes, plus the
 * Vite project root. No entrypoint gymnastics — `main` is still your
 * program module; the Vite build is the UI that rides along.
 */
export interface ViteProps extends Omit<ServiceProps, "vite"> {
  /**
   * The Vite PROJECT directory — where `vite.config.*` lives —
   * relative to `cwd`. The config file owns everything else (source
   * root, aliases, plugins, outDir).
   * @default "."
   */
  root?: string;
}

/**
 * A local service WITH a Vite-built UI — the local analog of
 * `Cloudflare.Website.Vite`:
 *
 * - at deploy, the project at `root` is built IN-PROCESS with the
 *   project's own Vite (config, plugins, and all — nothing to
 *   configure here beyond the root);
 * - the built client output is served from the SAME server as the
 *   program's `fetch` routes, ASSET-FIRST with an `index.html`
 *   fallback for HTML-accepting 404s (client-side routes deep-link;
 *   API 404s stay 404s);
 * - assets are read per request, so a UI-only edit (covered by
 *   `memo`) rebuilds WITHOUT restarting the process.
 *
 * @example
 * ```typescript
 * export default class Org extends Local.Vite<Org>()(
 *   "Org",
 *   {
 *     main: import.meta.url,
 *     root: "ui",
 *     memo: { include: ["src/**", "ui/**"] },
 *   },
 *   Effect.gen(function* () {
 *     return { fetch: apiRoutes };
 *   }),
 *   OrgLive,
 * ) {}
 * ```
 */
export const Vite: {
  <Self>(): <
    const Id extends string,
    Shape extends Main<Host>,
    PropsReq = never,
    LOut = never,
    LIn = never,
    InitReq extends Host | PlatformServices | Service | LOut = never,
  >(
    id: Id,
    props:
      | InputProps<ViteProps>
      | Effect.Effect<InputProps<ViteProps>, ConfigError.ConfigError, PropsReq>,
    impl: Effect.Effect<Shape, ConfigError.ConfigError, InitReq>,
    layers?: Layer.Layer<LOut, never, LIn>,
  ) => Effect.Effect<
    Service & Rpc<Self>,
    never,
    | Service["Providers"]
    | Exclude<PropsReq, Host | PlatformServices | Service>
    | Exclude<InitReq, Host | PlatformServices | Service | LOut>
    | Exclude<LIn, Host | PlatformServices | Service>
  > &
    Named<Id> & {
      new (_: never): MakeShape<Shape, {}> & Named<Id> & Tag<"Local.Service">;
    };
  (
    id: string,
    props?: InputProps<ViteProps> | Effect.Effect<InputProps<ViteProps>>,
  ): Effect.Effect<Service, never, Service["Providers"]>;
} = ((id?: any, props?: any, impl?: any, layers?: any) => {
  const map = (input: any) =>
    input === undefined
      ? input
      : (({ root, ...rest }: any) => ({ ...rest, vite: { root } }))(input);
  return id === undefined
    ? (id: string, props: any, impl: any, layers: any) =>
        ((Service as any)() as any)(id, map(props), impl, layers)
    : (Service as any)(id, map(props), impl, layers);
}) as any;
