import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";

export interface ListBrowserSessionsRequest extends Omit<
  agentcore.ListBrowserSessionsRequest,
  "browserIdentifier"
> {}

/**
 * Lists the browser's sessions.
 *
 * Bind a {@link BrowserCustom} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.ListBrowserSessionsHttp`
 * on the Function effect to implement the binding.
 *
 * ### Browser Sessions
 * **Example:** List Sessions
 * ```typescript
 * // init
 * const listBrowserSessions = yield* AgentCore.ListBrowserSessions(browser);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const result = yield* listBrowserSessions({});
 *     return HttpServerResponse.json({ count: result.items?.length ?? 0 });
 *   }),
 * };
 * ```
 *
 * @binding
 */
export interface ListBrowserSessions extends Binding.Service<
  ListBrowserSessions,
  "AWS.BedrockAgentCore.ListBrowserSessions",
  <R extends BrowserCustom>(
    browser: R,
  ) => Effect.Effect<
    (
      request: ListBrowserSessionsRequest,
    ) => Effect.Effect<agentcore.ListBrowserSessionsResponse, agentcore.ListBrowserSessionsError>
  >
> {}
export const ListBrowserSessions = Binding.Service<ListBrowserSessions>(
  "AWS.BedrockAgentCore.ListBrowserSessions",
);

export const ListBrowserSessionsHttp = Layer.effect(
  ListBrowserSessions,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.ListBrowserSessions",
    operation: agentcore.listBrowserSessions,
    actions: ["bedrock-agentcore:ListBrowserSessions"],
    requestKey: "browserIdentifier",
    identifier: (browser: BrowserCustom) => browser.browserId,
    arns: (browser: BrowserCustom) => [browser.browserArn],
  }),
);
