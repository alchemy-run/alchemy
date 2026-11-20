import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";

export interface GetBrowserSessionRequest extends Omit<
  agentcore.GetBrowserSessionRequest,
  "browserIdentifier"
> {}

/**
 * Reads a browser session's configuration, status, and stream endpoints.
 *
 * Bind a {@link BrowserCustom} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.GetBrowserSessionHttp`
 * on the Function effect to implement the binding.
 *
 * ### Browser Sessions
 * **Example:** Read a Session
 * ```typescript
 * // init
 * const getBrowserSession = yield* AgentCore.GetBrowserSession(browser);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* getBrowserSession({ sessionId });
 *     return HttpServerResponse.json({ status: result.status });
 *   }),
 * };
 * ```
 *
 * @binding
 */
export interface GetBrowserSession extends Binding.Service<
  GetBrowserSession,
  "AWS.BedrockAgentCore.GetBrowserSession",
  <R extends BrowserCustom>(
    browser: R,
  ) => Effect.Effect<
    (
      request: GetBrowserSessionRequest,
    ) => Effect.Effect<agentcore.GetBrowserSessionResponse, agentcore.GetBrowserSessionError>
  >
> {}
export const GetBrowserSession = Binding.Service<GetBrowserSession>(
  "AWS.BedrockAgentCore.GetBrowserSession",
);

export const GetBrowserSessionHttp = Layer.effect(
  GetBrowserSession,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.GetBrowserSession",
    operation: agentcore.getBrowserSession,
    actions: ["bedrock-agentcore:GetBrowserSession"],
    requestKey: "browserIdentifier",
    identifier: (browser: BrowserCustom) => browser.browserId,
    arns: (browser: BrowserCustom) => [browser.browserArn],
  }),
);
