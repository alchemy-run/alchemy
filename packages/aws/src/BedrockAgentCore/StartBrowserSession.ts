import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Binding from "alchemy/Binding";
import { toWireSeconds } from "alchemy/Util/Duration";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";

export interface StartBrowserSessionRequest extends Omit<
  agentcore.StartBrowserSessionRequest,
  "browserIdentifier" | "sessionTimeoutSeconds"
> {
  /**
   * How long the session may sit idle before AgentCore terminates it, e.g.
   * `"5 minutes"` or `Duration.minutes(5)` (a bare number is milliseconds).
   */
  sessionTimeout?: Duration.Input;
}

/**
 * Starts a managed, sandboxed browser session on a custom browser.
 *
 * Bind a {@link BrowserCustom} inside a function runtime to open cloud
 * browser sessions for web automation; pair with `GetBrowserSession`,
 * `InvokeBrowser`, and `StopBrowserSession`. Provide
 * `AgentCore.StartBrowserSessionHttp` on the Function effect to implement
 * the binding.
 *
 * ### Browser Sessions
 * **Example:** Start and Stop a Browser Session
 * ```typescript
 * // init
 * const startBrowserSession = yield* AgentCore.StartBrowserSession(browser);
 * const stopBrowserSession = yield* AgentCore.StopBrowserSession(browser);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const session = yield* startBrowserSession({
 *       sessionTimeout: "5 minutes",
 *     });
 *     yield* stopBrowserSession({ sessionId: session.sessionId });
 *     return HttpServerResponse.json({ sessionId: session.sessionId });
 *   }),
 * };
 * ```
 *
 * @binding
 */
export interface StartBrowserSession extends Binding.Service<
  StartBrowserSession,
  "AWS.BedrockAgentCore.StartBrowserSession",
  <R extends BrowserCustom>(
    browser: R,
  ) => Effect.Effect<
    (
      request: StartBrowserSessionRequest,
    ) => Effect.Effect<agentcore.StartBrowserSessionResponse, agentcore.StartBrowserSessionError>
  >
> {}
export const StartBrowserSession = Binding.Service<StartBrowserSession>(
  "AWS.BedrockAgentCore.StartBrowserSession",
);

// Bespoke (not the shared scaffold): converts the ergonomic `sessionTimeout`
// Duration.Input to the wire `sessionTimeoutSeconds` field.
export const StartBrowserSessionHttp = Layer.effect(
  StartBrowserSession,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const startBrowserSession = yield* AWSBindings.withCredentials(agentcore.startBrowserSession);

    return Effect.fn(function* <R extends BrowserCustom>(browser: R) {
      const Identifier = yield* browser.browserId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.BedrockAgentCore.StartBrowserSession(${browser})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["bedrock-agentcore:StartBrowserSession"],
              Resource: [browser.browserArn],
            },
          ],
        });
      }
      return Effect.fn(`AWS.BedrockAgentCore.StartBrowserSession(${browser.LogicalId})`)(
        function* ({ sessionTimeout, ...request }: StartBrowserSessionRequest) {
          return yield* startBrowserSession({
            ...request,
            sessionTimeoutSeconds: toWireSeconds(sessionTimeout),
            browserIdentifier: yield* Identifier,
          });
        },
      );
    });
  }),
);
