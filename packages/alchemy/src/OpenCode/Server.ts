import * as Effect from "effect/Effect";
import { acpDriver } from "../AI/AcpDriver.ts";
import {
  DEFAULT_CWD,
  makeHarnessServer,
  npmInstallLayer,
  type HarnessServerOptions,
} from "../AI/HarnessServer.ts";

/** The OpenCode version server images install by default. */
export const OPENCODE_VERSION = "1.18.18";

export interface ServerProps {
  /**
   * Directory sessions work in by default — usually a mounted repository
   * (`cwd: app.path`). Sessions can override it on `start`.
   * @default "/workspace"
   */
  cwd?: string;
  /**
   * Provider credentials OpenCode reads from its environment, e.g.
   * `{ ANTHROPIC_API_KEY: Alchemy.Secret("ANTHROPIC_API_KEY") }` or an
   * OpenCode Zen/Go key. Bound into the host's environment.
   */
  env?: HarnessServerOptions<never>["env"];
  /**
   * Default model as `provider/model`, e.g. `anthropic/claude-haiku-4-5`.
   * @default OpenCode's own default for the configured provider
   */
  model?: string;
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
    cwd: props.cwd ?? DEFAULT_CWD,
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
        ...(props.model
          ? { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: props.model }) } }
          : {}),
        cwd: props.cwd ?? DEFAULT_CWD,
      }),
    ),
  });
