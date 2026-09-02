import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { ApiToken, ApiTokenProvider } from "./ApiToken.ts";
import { ForgejoAuth } from "./AuthProvider.ts";
import {
  BranchProtection,
  BranchProtectionProvider,
} from "./BranchProtection.ts";
import {
  type ForgejoClientOptions,
  fromAuthProvider,
  fromToken,
} from "./Credentials.ts";
import { Label, LabelProvider } from "./Label.ts";
import { Organization, OrganizationProvider } from "./Organization.ts";
import { Repository, RepositoryProvider } from "./Repository.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { Team, TeamProvider } from "./Team.ts";
import { TeamMember, TeamMemberProvider } from "./TeamMember.ts";
import { Variable, VariableProvider } from "./Variable.ts";
import { Webhook, WebhookProvider } from "./Webhook.ts";

/** Provider collection required by Forgejo resources. */
export class Providers extends Provider.ProviderCollection<Providers>()(
  "Forgejo",
) {}

/** Services supplied by {@link providers}. */
export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/** Options for the Forgejo provider collection. */
export type ProvidersOptions = ForgejoClientOptions;

/**
 * Build all Forgejo providers plus the Forgejo `AuthProvider` that the
 * alchemy CLI discovers.
 *
 * With no options, credentials come from the selected profile
 * (`alchemy profile edit --add Forgejo`), falling back to `FORGEJO_URL` /
 * `FORGEJO_TOKEN` in CI.
 * Pass `{ baseUrl, token }` to pin an instance and credential in code and
 * bypass profile resolution entirely.
 *
 * The generated `@distilled.cloud/forgejo` operations resolve their
 * `HttpClient` from the context they run in rather than constructing one.
 * This layer takes the `HttpClient` it is built with — the CLI's, or the
 * one a test provides — and hands that same client to every resource, so
 * pointing the collection at an in-memory instance is a single
 * `Layer.provide`.
 */
export const providers = (options?: ProvidersOptions) => {
  const credentials =
    options === undefined ? fromAuthProvider() : fromToken(options);

  // Re-export the ambient client into this layer's output: without it, the
  // resources' operations would fall through to whatever `HttpClient` the
  // engine runtime carries, bypassing the one the layer was given.
  const httpClient = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      return yield* HttpClient.HttpClient;
    }),
  );

  return Layer.effect(
    Providers,
    Provider.collection([
      ApiToken,
      BranchProtection,
      Label,
      Organization,
      Repository,
      Secret,
      Team,
      TeamMember,
      Variable,
      Webhook,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ApiTokenProvider(),
        BranchProtectionProvider(),
        LabelProvider(),
        OrganizationProvider(),
        RepositoryProvider(),
        SecretProvider(),
        TeamProvider(),
        TeamMemberProvider(),
        VariableProvider(),
        WebhookProvider(),
      ),
    ),
    Layer.provideMerge(credentials),
    Layer.provideMerge(httpClient),
    Layer.provideMerge(ForgejoAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
};
