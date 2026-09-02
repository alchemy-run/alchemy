import * as EffectContext from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

export class AlchemyContext extends EffectContext.Service<
  AlchemyContext,
  {
    dotAlchemy: string;
    dev: boolean;
    /**
     * Global default for the {@link import("./AdoptPolicy.ts").AdoptPolicy}
     * service. When `true`, resources without prior state will be adopted by
     * calling their `read` lifecycle operation; if that returns attributes
     * (and does not fail with `OwnedBySomeoneElse`), those attributes are
     * persisted as the resource's initial `created` state.
     *
     * The CLI's `--adopt` flag flows in through this field. Per-resource
     * overrides via the `adopt(enabled)` combinator still take precedence.
     */
    adopt: boolean;
    /**
     * When `true`, an out-of-date Cloudflare state store is upgraded
     * automatically instead of prompting for confirmation (and the upgrade
     * proceeds even in CI). The CLI's `--yes` flag flows in through this field.
     * @default false
     */
    updateStateStore?: boolean;
    /**
     * The `alchemy dev` ingress: every locally served resource is exposed on
     * one shared port as `<name>.<domain>` (and, with `tunnel`, through a
     * Cloudflare quick tunnel). Set by the `dev` command from `--domain`,
     * `--port` and `--tunnel`; absent outside dev (and in dev tests that
     * don't opt in), in which case resources keep their per-resource
     * `http://localhost:<port>` URLs only.
     */
    ingress?: DevIngressOptions;
  }
>()("alchemy/Context") {}

/** Options of the shared `alchemy dev` ingress (see {@link AlchemyContext}). */
export interface DevIngressOptions {
  /** Domain local hosts are subdomains of, e.g. `localhost` or `myapp.test`. */
  readonly domain: string;
  /** Port the ingress listens on. */
  readonly port: number;
  /** Expose every local host through a Cloudflare quick tunnel. */
  readonly tunnel: boolean;
  /**
   * Connect to an Alchemy dev relay instead of (or as well as) quick
   * tunnels: one WebSocket from the dev sidecar to the relay, which routes
   * `https://<name>.<namespace>.<relay domain>` back down it by `Host`.
   */
  readonly relay?: DevRelayOptions;
}

/** How `alchemy dev` connects to a dev relay (see `Local/Relay`). */
export interface DevRelayOptions {
  /** The relay's base URL, e.g. `https://dev.alchemy.run`. */
  readonly url: string;
  /** The namespace this session owns: hosts are `<name>.<namespace>.<domain>`. */
  readonly namespace: string;
  /** Bearer token presented on connect (`ALCHEMY_DEV_RELAY_TOKEN`). */
  readonly token?: string;
}

export const AlchemyContextLive = Layer.effect(
  AlchemyContext,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(process.cwd(), ".alchemy");
    yield* fs.makeDirectory(dir, { recursive: true });
    return {
      dotAlchemy: dir,
      updateStateStore: false,
      dev: false,
      adopt: false,
    };
  }),
);
