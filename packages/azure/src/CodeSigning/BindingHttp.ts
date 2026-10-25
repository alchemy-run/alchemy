import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import { collectAll } from "../Arm.ts";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Account } from "./Account.ts";
import type { CertificateProfile } from "./CertificateProfile.ts";

/**
 * Shared scaffolding for the Artifact Signing HTTP bindings. NOT exported
 * from `index.ts`: every `{Op}Http.ts` is a thin
 * `Layer.effect(Cap, makeCertificateProfileHttpBinding({ … }))`.
 *
 * Every signing operation needs the data action
 * `certificateProfiles/Sign/action`. The built-in **Artifact Signing
 * Certificate Profile Signer** also reads every `Microsoft.CodeSigning`
 * resource and runs deployments, so the binding assigns a custom role with
 * exactly the data action (`AzureCodeSigningSignRole`, one per stack) on the
 * certificate profile only.
 */

/** The one data action the signing data plane checks. */
export const SIGN_DATA_ACTION = "Microsoft.CodeSigning/certificateProfiles/Sign/action";

/** Attach the binding to its host and assign the sign role on the profile. */
const GrantOnProfile = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (tag: string, profile: CertificateProfile) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const role = yield* AzureRoleDefinition("AzureCodeSigningSignRole", {
        description: `Alchemy Artifact Signing binding: ${SIGN_DATA_ACTION}`,
        permissions: [{ dataActions: [SIGN_DATA_ACTION] }],
      });
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [
        { roleDefinitionId: role.roleDefinitionId, scope: profile.profileId },
      ];
      yield* bind`${tag}(${profile})`({ roleAssignments });
    }
  });
});

/** The request members the bound account and profile supply. */
type ProfileIds = "endpoint" | "accountName" | "certificateProfile";

/** Where a profile is served, resolved per call at runtime. */
const addressOf = Effect.fn(function* (account: Account | string, profile: CertificateProfile) {
  const accountUri =
    typeof account === "string" ? Effect.succeed(account) : yield* account.accountUri;
  const accountName = yield* profile.account;
  const certificateProfile = yield* profile.profileName;
  return Effect.gen(function* () {
    // The account URI ends with `/`; the operation paths start with one.
    const endpoint = (yield* accountUri).replace(/\/+$/, "");
    return {
      endpoint,
      accountName: yield* accountName,
      certificateProfile: yield* certificateProfile,
    };
  });
});

/** A distilled signing operation, resolved with the host's credentials. */
type Operation<I, A, E> = Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;

/**
 * Build the impl Effect for a certificate-profile operation: the runtime
 * callable injects the account's regional endpoint, the account name and
 * the profile name, and the deploy-time half assigns the sign role on the
 * profile.
 */
export const makeCertificateProfileHttpBinding = <
  I extends { endpoint: string; accountName: string; certificateProfile: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.CodeSigning.Sign`. */
  tag: string;
  /** The distilled operation; the endpoint, account and profile are injected. */
  operation: Operation<I, A, E>;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantOnProfile;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (account: Account | string, profile: CertificateProfile) {
      yield* grant(options.tag, profile);
      const address = yield* addressOf(account, profile);
      return Effect.fn(`${options.tag}(${profile.LogicalId})`)(function* (
        request?: Omit<I, ProfileIds>,
      ) {
        const where = yield* address;
        // `Omit<I, K> & Pick<I, K>` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, ...where } as I);
      });
    });
  });

/**
 * Build the impl Effect for a paginated certificate-profile list operation:
 * every item across pages.
 */
export const makeCertificateProfileListHttpBinding = <
  I extends { endpoint: string; accountName: string; certificateProfile: string },
  Item,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.CodeSigning.ListExtendedKeyUsages`. */
  tag: string;
  /** The distilled paginated operation. */
  operation: Effect.Effect<{ readonly items: (input: I) => Stream.Stream<Item, E> }, never, any>;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantOnProfile;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (account: Account | string, profile: CertificateProfile) {
      yield* grant(options.tag, profile);
      const address = yield* addressOf(account, profile);
      return Effect.fn(`${options.tag}(${profile.LogicalId})`)(function* () {
        const where = yield* address;
        const all = yield* collectAll(op, where as I);
        return all.value;
      });
    });
  });
