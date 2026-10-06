import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import {
  CLAUDE_AGENT_SDK,
  CLAUDE_AGENT_SDK_VERSION,
  claudeCodeDriver,
  type ClaudeCodeOptions,
} from "../AI/ClaudeCodeDriver.ts";
import { makeHarnessServer, npmInstallLayer } from "../AI/HarnessServer.ts";

/** The container env var carrying a named account's token. */
const accountEnvKey = (name: string) =>
  `ALCHEMY_CLAUDE_ACCOUNT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

export interface ClaudeCodeServerProps {
  /**
   * Anthropic API key for the `claude` process (`ANTHROPIC_API_KEY`). Bound
   * into the host's environment — never baked into the image.
   */
  apiKey?: string | Redacted.Redacted<string>;
  /**
   * A Claude subscription token from `claude setup-token`
   * (`CLAUDE_CODE_OAUTH_TOKEN`) — the official way to run the unmodified
   * Claude Code binary on your own subscription.
   */
  oauthToken?: string | Redacted.Redacted<string>;
  /**
   * Several Claude subscriptions by name — each a token from
   * `claude setup-token` for one of YOUR accounts. A session picks one with
   * `start({ account: "work" })`; with no account it uses `oauthToken` /
   * `apiKey`, or the only account when there is exactly one.
   *
   * Each token only ever reaches the unmodified `claude` binary for sessions
   * that name it. There is deliberately no automatic rotation across
   * accounts: pick explicitly, under your own agreement with Anthropic.
   */
  accounts?: Record<string, string | Redacted.Redacted<string>>;
  /** Default model for sessions (e.g. `claude-opus-5-5`). */
  model?: string;
  /**
   * Default permission mode. Sessions started with `approvals: "ask"` use
   * `default` and surface `permission.requested` events.
   * @default "bypassPermissions" (the container is the sandbox)
   */
  permissionMode?: ClaudeCodeOptions["permissionMode"];
  /** Agent SDK version installed into the image. @default the version Alchemy is tested against */
  version?: string;
}

/**
 * Claude Code, running inside the container it is yielded in.
 *
 * At deploy time it installs Anthropic's official Agent SDK (which ships the
 * unmodified `claude` binary) into the container image and binds its
 * credentials into the container environment. At runtime it returns an
 * `AI.Harness`: start sessions, prompt, steer, interrupt, and stream
 * normalized `AI.SessionEvent`s.
 *
 * ### Running Claude Code in a container
 * **Example:** A container that serves Claude Code sessions
 * ```typescript
 * import * as AI from "alchemy/AI";
 * import * as Anthropic from "alchemy/Anthropic";
 *
 * export default Sandbox.make(
 *   { main: import.meta.url, runtime: "node", environment: Workspace },
 *   Effect.gen(function* () {
 *     const claude = yield* Anthropic.ClaudeCodeServer("Claude", {
 *       apiKey: Alchemy.Secret("ANTHROPIC_API_KEY"),
 *     });
 *     return { fetch: yield* AI.serveHarnessHttp(claude) };
 *   }),
 * );
 * ```
 *
 * The image needs Node.js (e.g. `environment: { base: "node:22-bookworm" }`
 * with `runtime: "node"`).
 *
 * @binding
 * @product Claude Code
 * @category AI
 */
export const ClaudeCodeServer = (id = "ClaudeCode", props: ClaudeCodeServerProps = {}) =>
  makeHarnessServer({
    id,
    image: [
      npmInstallLayer(
        `claude-agent-sdk@${props.version ?? CLAUDE_AGENT_SDK_VERSION}`,
        [`${CLAUDE_AGENT_SDK}@${props.version ?? CLAUDE_AGENT_SDK_VERSION}`],
        { into: "app" },
      ),
    ],
    env: {
      ...(props.apiKey !== undefined ? { ANTHROPIC_API_KEY: props.apiKey } : {}),
      ...(props.oauthToken !== undefined ? { CLAUDE_CODE_OAUTH_TOKEN: props.oauthToken } : {}),
      ...Object.fromEntries(
        Object.entries(props.accounts ?? {}).map(([name, token]) => [accountEnvKey(name), token]),
      ),
    },
    driver: Effect.sync(() =>
      claudeCodeDriver({
        cwd: process.env.ALCHEMY_WORKDIR ?? "/workspace",
        accountEnv: (account): Record<string, string> | undefined => {
          const names = Object.keys(props.accounts ?? {});
          const hasDefault = props.apiKey !== undefined || props.oauthToken !== undefined;
          const name = account ?? (!hasDefault && names.length === 1 ? names[0] : undefined);
          if (name === undefined) return account === undefined ? {} : undefined;
          const token = process.env[accountEnvKey(name)];
          // The account's token replaces any default credential for this session.
          return token ? { CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_API_KEY: "" } : undefined;
        },
        ...(props.model ? { model: props.model } : {}),
        ...(props.permissionMode ? { permissionMode: props.permissionMode } : {}),
      }),
    ),
  });
