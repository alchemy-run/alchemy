import { Retry as CoolifyRetry } from "@distilled.cloud/coolify/Retry";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as DeployRetry from "alchemy/DeployRetry";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { Application, ApplicationProvider } from "./Application.ts";
import { CoolifyAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { Postgres, PostgresProvider } from "./Database/Postgres.ts";
import { Environment, EnvironmentProvider } from "./Environment.ts";
import { EnvVar, EnvVarProvider } from "./EnvVar.ts";
import { Project, ProjectProvider } from "./Project.ts";

export { Credentials } from "@distilled.cloud/coolify/Credentials";

export class Providers extends Provider.ProviderCollection<Providers>()("Coolify") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Coolify providers and credentials. Registers the Project, Environment,
 * Application, Database.Postgres and EnvVar providers, the resolved
 * `Credentials`, and the Coolify AuthProvider so `alchemy profile edit` can
 * configure it.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Coolify from "@alchemy.run/coolify";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   { providers: Coolify.providers(), state: Alchemy.localState() },
 *   Effect.gen(function* () {
 *     const project = yield* Coolify.Project("app", {});
 *     return { projectUuid: project.projectUuid };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([Project, Environment, Application, Postgres, EnvVar]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ProjectProvider(),
        EnvironmentProvider(),
        ApplicationProvider(),
        PostgresProvider(),
        EnvVarProvider(),
      ),
    ),
    Layer.provideMerge(Layer.succeed(CoolifyRetry, DeployRetry.policy)),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(CoolifyAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
