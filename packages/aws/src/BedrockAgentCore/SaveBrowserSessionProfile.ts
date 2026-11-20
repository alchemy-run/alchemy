import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";

export interface SaveBrowserSessionProfileRequest extends Omit<
  agentcore.SaveBrowserSessionProfileRequest,
  "browserIdentifier"
> {}

/**
 * Persists a browser session's state to a reusable browser profile.
 *
 * Bind a {@link BrowserCustom} inside a function runtime to call the
 * AgentCore data-plane API against it. Provide `AgentCore.SaveBrowserSessionProfileHttp`
 * on the Function effect to implement the binding.
 *
 * ### Browser Profiles
 * **Example:** Save a Session Profile
 * ```typescript
 * // init
 * const saveBrowserSessionProfile = yield* AgentCore.SaveBrowserSessionProfile(browser);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* saveBrowserSessionProfile({
 *       sessionId,
 *       profileIdentifier,
 *     });
 *     return HttpServerResponse.json({ saved: true });
 *   }),
 * };
 * ```
 *
 * @binding
 */
export interface SaveBrowserSessionProfile extends Binding.Service<
  SaveBrowserSessionProfile,
  "AWS.BedrockAgentCore.SaveBrowserSessionProfile",
  <R extends BrowserCustom>(
    browser: R,
  ) => Effect.Effect<
    (
      request: SaveBrowserSessionProfileRequest,
    ) => Effect.Effect<
      agentcore.SaveBrowserSessionProfileResponse,
      agentcore.SaveBrowserSessionProfileError
    >
  >
> {}
export const SaveBrowserSessionProfile = Binding.Service<SaveBrowserSessionProfile>(
  "AWS.BedrockAgentCore.SaveBrowserSessionProfile",
);

export const SaveBrowserSessionProfileHttp = Layer.effect(
  SaveBrowserSessionProfile,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.SaveBrowserSessionProfile",
    operation: agentcore.saveBrowserSessionProfile,
    actions: ["bedrock-agentcore:SaveBrowserSessionProfile"],
    requestKey: "browserIdentifier",
    identifier: (browser: BrowserCustom) => browser.browserId,
    arns: (browser: BrowserCustom) => [browser.browserArn],
  }),
);
