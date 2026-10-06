import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { codexDriver, type CodexOptions } from "../AI/CodexDriver.ts";
import { makeHarnessServer, npmInstallLayer } from "../AI/HarnessServer.ts";

/** The Codex CLI version server images install by default. */
export const CODEX_VERSION = "0.160.1";

export interface CodexServerProps {
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
 * `codex app-server` as an `AI.Harness`.
 *
 * ### Running Codex in a container
 * **Example:** A container that serves Codex sessions
 * ```typescript
 * export default Sandbox.make(
 *   { main: import.meta.url, runtime: "node", environment: Workspace },
 *   Effect.gen(function* () {
 *     const codex = yield* OpenAI.CodexServer("Codex", {
 *       apiKey: Alchemy.Secret("OPENAI_API_KEY"),
 *     });
 *     return { fetch: yield* AI.serveHarnessHttp(codex) };
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
    image: [
      npmInstallLayer(`codex@${props.version ?? CODEX_VERSION}`, [
        `@openai/codex@${props.version ?? CODEX_VERSION}`,
      ]),
    ],
    env: props.apiKey !== undefined ? { OPENAI_API_KEY: props.apiKey } : {},
    driver: Effect.suspend(() =>
      codexDriver({
        cwd: process.env.ALCHEMY_WORKDIR ?? "/workspace",
        ...(props.model ? { model: props.model } : {}),
        ...(props.sandbox ? { sandbox: props.sandbox } : {}),
      }),
    ),
  });
