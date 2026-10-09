import * as Effect from "effect/Effect";
import type { ImageLayer } from "../Docker/ImageLayer.ts";
import { acpDriver } from "./AcpDriver.ts";
import { DEFAULT_CWD, makeHarnessServer, type HarnessServerOptions } from "./HarnessServer.ts";

export interface AcpServerProps {
  /**
   * Directory sessions work in by default — usually a mounted repository
   * (`cwd: app.path`). Sessions can override it on `start`.
   * @default "/workspace"
   */
  cwd?: string;
  /** The agent executable, e.g. `"gemini"`. */
  command: string;
  /** Arguments that put it in ACP mode, e.g. `["--experimental-acp"]`. */
  args?: string[];
  /** Image layers that install the agent (see `AI.npmInstallLayer`). */
  install?: ImageLayer[];
  /** Environment the agent needs (credentials). Bound into the host's environment. */
  env?: HarnessServerOptions<never>["env"];
}

/**
 * Any Agent Client Protocol agent, running inside the container it is
 * yielded in, exposed as an `AI.Harness`. Covers the long tail of coding
 * agents (Gemini CLI, Grok, …) with one integration.
 *
 * ### Running an ACP agent
 * **Example:** Gemini CLI in a container
 * ```typescript
 * const gemini = yield* AI.AcpServer("Gemini", {
 *   command: "gemini",
 *   args: ["--experimental-acp"],
 *   install: [AI.npmInstallLayer("gemini-cli", ["@google/gemini-cli"])],
 *   env: { GEMINI_API_KEY: Alchemy.Secret("GEMINI_API_KEY") },
 * });
 * ```
 *
 * @binding
 * @product Agent Client Protocol
 * @category AI
 */
export const AcpServer = (id: string, props: AcpServerProps) =>
  makeHarnessServer({
    id,
    cwd: props.cwd ?? DEFAULT_CWD,
    ...(props.install ? { image: props.install } : {}),
    ...(props.env ? { env: props.env } : {}),
    driver: Effect.suspend(() =>
      acpDriver({
        name: id,
        command: props.command,
        ...(props.args ? { args: props.args } : {}),
        cwd: props.cwd ?? DEFAULT_CWD,
      }),
    ),
  });
