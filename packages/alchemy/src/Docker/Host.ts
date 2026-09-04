import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * The DOCKER-IMAGE HOST this code will run on — the cloud-agnostic
 * seam between a `Binding.Service` and the image of whatever machine
 * hosts it. Aligned with `Local.Host` (a local process host): the
 * namespace defines the kind of host.
 *
 * Any image-GENERATING platform provides it at plan time —
 * `Cloudflare.Container`, `AWS.Lambda.MicrovmImage`, `AWS.ECS.Task`,
 * `AWS.ECS.Service`, `Docker.Service` — so a layer can install its own
 * system dependencies into the image without knowing the cloud, only
 * the image and the architecture:
 *
 * ```ts
 * // inside a binding impl's plan branch (!globalThis.__ALCHEMY_RUNTIME__)
 * const host = yield* Effect.serviceOption(Docker.Host);
 * if (Option.isSome(host)) {
 *   yield* host.value.install(
 *     ({ arch }) => `RUN curl -fsSL https://example.com/tool_linux_${arch}.deb ...`,
 *   );
 * }
 * ```
 *
 * Absent at runtime, and absent on platforms that don't own their image
 * (pre-built `image:` refs, user `context:` builds, hosts without
 * images at all) — a binding that requires the seam should fail loud on
 * `Option.none`, not degrade.
 *
 * **Adoption recipe for a platform** (three touch points):
 * 1. spread {@link makeHostCollector} into the platform's runtime
 *    context (`planServices` + `planProps`);
 * 2. carry `imageStatements?: Host.Statements` on the platform's
 *    effectful props (internal, hash-participating);
 * 3. splice {@link hostStatementsFor}`(props, arch)` into the
 *    platform's generated-Dockerfile assembly, picking the deploy
 *    architecture the platform actually targets (Cloudflare: always
 *    `amd64`; MicroVM: `cpuConfigurations`; ECS: `runtimePlatform`).
 */
export class Host extends Context.Service<
  Host,
  {
    /**
     * Append a fragment to the host image's Dockerfile. Rendered once
     * per target architecture at plan time and deduplicated by rendered
     * content — binding the same capability twice installs its tooling
     * once.
     */
    readonly install: (fragment: Host.Fragment) => Effect.Effect<void>;
  }
>()("alchemy/Docker/Host") {}

export declare namespace Host {
  /**
   * A CPU architecture in Docker/dpkg naming — the vocabulary fragments
   * interpolate into: release URLs (`tool_linux_${arch}.deb`),
   * `--platform linux/${arch}` flags, `dpkg` package names.
   */
  export type Architecture = "amd64" | "arm64";

  /** What a fragment renders against. Extensible (an `arch` today). */
  export interface ImageTarget {
    readonly arch: Architecture;
  }

  /**
   * A contribution to the host image: a literal Dockerfile statement
   * block, or a pure function of the build target. Fragments must be
   * self-contained statements (`RUN`, `ENV`, `COPY --from=…`); they are
   * spliced between the image's base layers and the bundled program,
   * so their layers cache across code changes.
   */
  export type Fragment = string | ((target: ImageTarget) => string);

  /**
   * The per-architecture rendering of every contributed fragment —
   * plain, serializable data carried on the platform's props as
   * `imageStatements` (participating in the image hash, so a changed
   * fragment rebuilds the image). Populated by the platform; never
   * written by hand.
   */
  export interface Statements {
    readonly amd64: ReadonlyArray<string>;
    readonly arm64: ReadonlyArray<string>;
  }
}

/** The machine's own architecture — what a `"native"` dev image targets. */
export const hostArchitecture = (): Host.Architecture =>
  process.arch === "arm64" ? "arm64" : "amd64";

/** `"linux/arm64"` → `"arm64"`; anything else is `amd64`. */
export const architectureOfPlatform = (platform: string): Host.Architecture =>
  platform.endsWith("arm64") ? "arm64" : "amd64";

/**
 * Render fragments once per architecture, deduplicating identical
 * rendered statements while preserving contribution order.
 */
export const renderHostFragments = (
  fragments: ReadonlyArray<Host.Fragment>,
): Host.Statements => {
  const render = (arch: Host.Architecture) => [
    ...new Set(
      fragments.map((fragment) =>
        typeof fragment === "string" ? fragment : fragment({ arch }),
      ),
    ),
  ];
  return { amd64: render("amd64"), arm64: render("arm64") };
};

/**
 * Everything a platform spreads into its runtime context to host the
 * seam: a plan-phase {@link Host} service collecting fragments, and the
 * `planProps` lowering that lands their per-arch rendering on the
 * resource's props as `imageStatements`.
 */
export const makeHostCollector = (): {
  planServices: Layer.Layer<Host>;
  planProps: Effect.Effect<{ imageStatements?: Host.Statements }>;
} => {
  const fragments: Host.Fragment[] = [];
  return {
    planServices: Layer.succeed(
      Host,
      Host.of({
        install: (fragment) =>
          Effect.sync(() => {
            fragments.push(fragment);
          }),
      }),
    ),
    planProps: Effect.sync(() =>
      fragments.length === 0
        ? {}
        : { imageStatements: renderHostFragments(fragments) },
    ),
  };
};

/**
 * The rendered statements for one target architecture, from the
 * per-arch `imageStatements` prop the platform populated.
 */
export const hostStatementsFor = (
  props: { imageStatements?: Host.Statements | undefined },
  arch: Host.Architecture,
): ReadonlyArray<string> => props.imageStatements?.[arch] ?? [];
