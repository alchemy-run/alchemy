import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { Agent, AgentProvider } from "./Agent.ts";
import { EntireAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { Environment, EnvironmentProvider } from "./Environment.ts";
import { OidcBinding, OidcBindingProvider } from "./OidcBinding.ts";
import { Org, OrgProvider } from "./Org.ts";
import { Project, ProjectProvider } from "./Project.ts";
import { Repo, RepoProvider } from "./Repo.ts";
import { ServiceAccount, ServiceAccountProvider } from "./ServiceAccount.ts";
import { ServiceAccountGrant, ServiceAccountGrantProvider } from "./ServiceAccountGrant.ts";

export { Credentials } from "@distilled.cloud/entire/Credentials";

export class Providers extends Provider.ProviderCollection<Providers>()("Entire") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Entire providers and credentials: orgs, projects, repositories (with their
 * branch rules, settings and model keys), service accounts with their OIDC bindings and grants, and
 * agents with their environments. Registers the Entire AuthProvider so
 * `alchemy profile edit` can configure it.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Agent,
      Environment,
      OidcBinding,
      Org,
      Project,
      Repo,
      ServiceAccount,
      ServiceAccountGrant,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AgentProvider(),
        EnvironmentProvider(),
        OidcBindingProvider(),
        OrgProvider(),
        ProjectProvider(),
        RepoProvider(),
        ServiceAccountProvider(),
        ServiceAccountGrantProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(EntireAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
