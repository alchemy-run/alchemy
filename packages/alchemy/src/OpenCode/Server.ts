import * as Effect from "effect/Effect";
import { acpDriver } from "../AI/AcpDriver.ts";
import {
  makeHarnessServer,
  npmInstallLayer,
  type HarnessServerOptions,
} from "../AI/HarnessServer.ts";

/** The OpenCode version server images install by default. */
export const OPENCODE_VERSION = "1.18.18";

export interface ServerProps {
  /**
   * Provider credentials OpenCode reads from its environment, e.g.
   * `{ ANTHROPIC_API_KEY: Alchemy.Secret("ANTHROPIC_API_KEY") }` or an
   * OpenCode Zen/Go key. Bound into the host's environment.
   */
  env?: HarnessServerOptions<never>["env"];
  /** `opencode-ai` version installed into the image. */
  version?: string;
}

/**
 * OpenCode, running inside the container it is yielded in (driven over its
 * Agent Client Protocol mode, `opencode acp`), exposed as an `AI.Harness`.
 *
 * ### Running OpenCode in a container
 * **Example:** OpenCode with an Anthropic key
 * ```typescript
 * const opencode = yield* OpenCode.Server("OpenCode", {
 *   env: { ANTHROPIC_API_KEY: Alchemy.Secret("ANTHROPIC_API_KEY") },
 * });
 * ```
 *
 * @binding
 * @product OpenCode
 * @category AI
 */
export const Server = (id = "OpenCode", props: ServerProps = {}) =>
  makeHarnessServer({
    id,
    image: [
      npmInstallLayer(`opencode@${props.version ?? OPENCODE_VERSION}`, [
        `opencode-ai@${props.version ?? OPENCODE_VERSION}`,
      ]),
    ],
    ...(props.env ? { env: props.env } : {}),
    driver: Effect.suspend(() =>
      acpDriver({
        name: "opencode",
        command: "opencode",
        args: ["acp"],
        cwd: process.env.ALCHEMY_WORKDIR ?? "/workspace",
      }),
    ),
  });
