import {
  DEFAULT_DOCKERFILE,
  makeCodingAgentContainer,
} from "alchemy/Cloudflare/AI";
import { OpenCodeAgent, type OpenCodeAgentOptions } from "./OpenCodeAgent.ts";

/**
 * Version of `@ai-sdk/harness-opencode` installed into the container image.
 * Keep in sync with this package's `@ai-sdk/harness-opencode` dependency (the
 * root `catalog`). Pinned because npm `latest` is a `0.0.0` placeholder.
 */
const HARNESS_OPENCODE_VERSION = "1.0.0-beta.1";

/**
 * The OpenCode bridge bootstraps itself inside the sandbox by shelling out to a
 * hardcoded `pnpm --dir <bootstrap> install --frozen-lockfile --store-dir <…>`
 * (`OpenCodeHarnessSettings` exposes no package-manager override). Rather than
 * ship `pnpm`, install a tiny `pnpm` shim that delegates to `bun install` — the
 * base image already has Bun, and the bridge's `package.json` pins exact
 * versions so a plain `bun install` resolves the same dependency set.
 *
 * The shim then runs `opencode-ai`'s `postinstall` explicitly: that script
 * copies the platform-specific `opencode` binary (a ~119 MB optional dep) over a
 * stub launcher, and the bridge is unusable without it. Both pnpm and Bun block
 * dependency lifecycle scripts by default — pnpm even exits non-zero
 * (`ERR_PNPM_IGNORED_BUILDS`), which the harness treats as a bootstrap failure —
 * so we must invoke it ourselves. The shim extracts the `--dir` target, ignores
 * pnpm-only flags, and always exits 0 on success.
 */
const OPENCODE_DOCKERFILE = `${DEFAULT_DOCKERFILE}
RUN printf '#!/bin/sh\\ndir="."\\nwhile [ $# -gt 0 ]; do case "$1" in --dir) dir="$2"; shift 2;; --store-dir) shift 2;; install|--frozen-lockfile) shift;; *) shift;; esac; done\\ncd "$dir" || exit 1\\nbun install || exit 1\\nif [ -f node_modules/opencode-ai/postinstall.mjs ]; then node node_modules/opencode-ai/postinstall.mjs || exit 1; fi\\nexit 0\\n' > /usr/local/bin/pnpm \\
  && chmod +x /usr/local/bin/pnpm
`;

/** Options for {@link OpenCodeContainer}: OpenCode's settings plus the
 * container entrypoint + image. `workspace`, `model`, and `session` are owned by
 * the container, so they are not accepted here. */
export interface OpenCodeContainerOptions extends Omit<
  OpenCodeAgentOptions,
  "workspace" | "model" | "session"
> {
  /**
   * The container's bundled entrypoint. Pass `import.meta.filename` from the
   * module whose **default export** is this `OpenCodeContainer(...)` call —
   * the container runtime imports that default export to boot the agent.
   */
  readonly main: string;
  /** Override the container image. */
  readonly dockerfile?: string;
}

/**
 * A deployable `CodingAgentContainer` runtime backed by OpenCode.
 *
 * Instantiate it from your own entrypoint module and re-export the result as
 * that module's default export (so the container runtime can boot it), then
 * provide the returned `Layer` on your Stack:
 *
 * @example
 * ```ts
 * // opencode-container.ts — the container entrypoint
 * import { OpenCodeContainer } from "@alchemy.run/harness-opencode";
 * import * as Config from "effect/Config";
 *
 * export default OpenCodeContainer({
 *   main: import.meta.filename,
 *   anthropic: { apiKey: Config.redacted("ANTHROPIC_API_KEY") },
 * });
 * ```
 *
 * ```ts
 * // alchemy.run.ts
 * import OpenCodeContainer from "./opencode-container.ts";
 * // ...Effect.provide(OpenCodeContainer)
 * ```
 */
export const OpenCodeContainer = ({
  main,
  dockerfile,
  ...auth
}: OpenCodeContainerOptions) =>
  makeCodingAgentContainer({
    main,
    dockerfile: dockerfile ?? OPENCODE_DOCKERFILE,
    runtime: (config) => OpenCodeAgent({ ...config, ...auth }),
    // The OpenCode harness reads its bridge assets (`dist/bridge/*`) from disk
    // relative to `import.meta.url` at runtime. Bundling inlines the JS but
    // drops those files, so keep the package external and let the image install
    // it (preserving the bridge assets next to the resolved module).
    //
    // Pin the version: the npm `latest` tag of `@ai-sdk/harness-opencode` is a
    // `0.0.0` placeholder, so a bare `bun add` would install the wrong package.
    // The real build ships under the `beta` tag. The version is stripped before
    // Rolldown's externalization match (see `externalMatchSpecifier`).
    external: [`@ai-sdk/harness-opencode@${HARNESS_OPENCODE_VERSION}`],
  });
