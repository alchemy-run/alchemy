import * as Layer from "effect/Layer";
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
} from "./Client.ts";
import { Label, LabelProvider } from "./Label.ts";
import { Organization, OrganizationProvider } from "./Organization.ts";
import { Repository, RepositoryProvider } from "./Repository.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { Team, TeamProvider } from "./Team.ts";
import { TeamMember, TeamMemberProvider } from "./TeamMember.ts";
import { Variable, VariableProvider } from "./Variable.ts";
import { Webhook, WebhookProvider } from "./Webhook.ts";

export { ForgejoCredentials } from "./Client.ts";

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
 */
export const providers = (options?: ProvidersOptions) => {
  const credentials =
    options === undefined ? fromAuthProvider() : fromToken(options);

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
    Layer.provideMerge(ForgejoAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
};
