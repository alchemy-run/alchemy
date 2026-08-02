import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import {
  makeSpacetimeDBAuth,
  type SpacetimeDBAuthOptions,
} from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { Database, DatabaseProvider } from "./Database.ts";
import { Generate, GenerateProvider } from "./Generate.ts";
import { Project, ProjectProvider } from "./Project.ts";
import {
  SpacetimeAuthProject,
  SpacetimeAuthProjectProvider,
} from "./SpacetimeAuth.ts";

export { SpacetimeDBCredentials } from "./Credentials.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "SpacetimeDB",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

export interface ProvidersOptions extends SpacetimeDBAuthOptions {}

/**
 * SpacetimeDB providers (Database, Generate, Project, SpacetimeAuth) plus
 * the AuthProvider that `alchemy login` discovers.
 *
 * During `alchemy dev`, {@link Database} runs in **local** mode
 * (`spacetime dev --server-only`). During `alchemy deploy` it publishes
 * to Maincloud (or the configured host).
 */
export const providers = (options?: ProvidersOptions) =>
  Layer.effect(
    Providers,
    Provider.collection([Database, Generate, Project, SpacetimeAuthProject]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        DatabaseProvider(),
        GenerateProvider(),
        ProjectProvider(),
        SpacetimeAuthProjectProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider(options)),
    Layer.provideMerge(makeSpacetimeDBAuth(options)),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );
