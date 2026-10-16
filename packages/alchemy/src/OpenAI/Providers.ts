import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { OpenAIAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { Project, ProjectProvider } from "./Project.ts";
import { ProjectRateLimit, ProjectRateLimitProvider } from "./ProjectRateLimit.ts";
import { ServiceAccount, ServiceAccountProvider } from "./ServiceAccount.ts";

/**
 * Service tag bundling all OpenAI providers + auth + credentials. Use
 * `OpenAI.providers()` to materialize the full layer.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("OpenAI") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build the complete OpenAI providers Layer: the Admin API resources
 * (`Project`, `ServiceAccount`, `ProjectRateLimit`), the OpenAI
 * `AuthProvider` registration, and credential resolution
 * (`OPENAI_API_KEY` / `OPENAI_ADMIN_KEY` or the selected profile).
 *
 * @example
 * ```typescript
 * export default Alchemy.Stack(
 *   "MyStack",
 *   { providers: OpenAI.providers(), state: Alchemy.localState() },
 *   Effect.gen(function* () {
 *     const project = yield* OpenAI.Project("App");
 *     return { projectId: project.projectId };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Project, ServiceAccount, ProjectRateLimit])).pipe(
    Layer.provide(
      Layer.mergeAll(ProjectProvider(), ServiceAccountProvider(), ProjectRateLimitProvider()),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(OpenAIAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
