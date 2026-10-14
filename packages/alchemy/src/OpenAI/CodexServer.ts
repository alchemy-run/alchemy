import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { codexDriver, type CodexOptions } from "../AI/CodexDriver.ts";
import { DEFAULT_CWD, makeHarnessServer, npmInstallLayer } from "../AI/HarnessServer.ts";

/** The Codex CLI version server images install by default. */
export const CODEX_VERSION = "0.160.1";

export interface CodexServerProps {
  /**
   * Directory sessions work in by default — usually a mounted repository
   * (`cwd: app.path`). Sessions can override it on `start`.
   * @default "/workspace"
   */
  cwd?: string;
  /** OpenAI API key for `codex` (`OPENAI_API_KEY`). Bound into the host's environment. */
  apiKey?: string | Redacted.Redacted<string>;
  /** Default model for sessions. */
  model?: string;
  /** Sandbox policy for commands Codex runs. @default "danger-full-access" (the container is the sandbox) */
  sandbox?: CodexOptions["sandbox"];
  /** `@openai/codex` version installed into the image. */
  version?: string;
}

/**
 * OpenAI Codex, running inside the container it is yielded in: installs the
 * `codex` CLI into the image, binds its credentials, and at runtime drives
 * `codex app-server` as an `AI.Harness`, served over HTTP (`fetch`).
 *
 * ### Running Codex in a sandbox
 * **Example:** A sandbox that serves Codex sessions
 * ```typescript
 * export default Cloudflare.Containers.Sandbox(
 *   Sandbox,
 *   {
 *     main: import.meta.url,
 *     runtime: "node",
 *     image: "node:22-bookworm",
 *     sizes: { small: "lite", large: "standard-4" },
 *   },
 *   Effect.gen(function* () {
 *     return yield* OpenAI.CodexServer("Codex", {
 *       apiKey: yield* Config.Redacted("OPENAI_API_KEY"),
 *       cwd: "/workspace/app",
 *     });
 *   }),
 * );
 * ```
 *
 * @binding
 * @product Codex
 * @category AI
 */
export const CodexServer = (id = "Codex", props: CodexServerProps = {}) =>
  makeHarnessServer({
    id,
    cwd: props.cwd ?? DEFAULT_CWD,
    image: [
      npmInstallLayer(`codex@${props.version ?? CODEX_VERSION}`, [
        `@openai/codex@${props.version ?? CODEX_VERSION}`,
      ]),
    ],
    env: props.apiKey !== undefined ? { OPENAI_API_KEY: props.apiKey } : {},
    driver: Effect.suspend(() =>
      codexDriver({
        cwd: props.cwd ?? DEFAULT_CWD,
        ...(props.model ? { model: props.model } : {}),
        ...(props.sandbox ? { sandbox: props.sandbox } : {}),
      }),
    ),
  });
