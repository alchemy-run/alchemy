import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { AnthropicAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { SpendLimit, SpendLimitProvider } from "./SpendLimit.ts";
import { Workspace, WorkspaceProvider } from "./Workspace.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Anthropic") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Anthropic providers and credentials. Wires up the control-plane resources
 * (`Workspace`, `SpendLimit`), the resolved Anthropic `Credentials`, an
 * `HttpClient`, and registers the Anthropic AuthProvider so
 * `alchemy profile edit` can configure it.
 *
 * The control-plane resources call the Admin API and need an Admin API key
 * (`ANTHROPIC_ADMIN_KEY`); `LanguageModel` needs an inference API key
 * (`ANTHROPIC_API_KEY`).
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Anthropic from "alchemy/Anthropic";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Anthropic.providers(),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     const workspace = yield* Anthropic.Workspace("Agents", {});
 *     return { workspaceId: workspace.workspaceId };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([SpendLimit, Workspace])).pipe(
    Layer.provide(Layer.mergeAll(SpendLimitProvider(), WorkspaceProvider())),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(AnthropicAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
