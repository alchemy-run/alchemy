import * as codesigning from "@distilled.cloud/azure/codesigning";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  stackAndStage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { getCodeSigningAccount } from "./Account.ts";

/** Kind of certificate a profile issues. */
export type CertificateProfileType =
  | "PublicTrust"
  | "PrivateTrust"
  | "PrivateTrustCIPolicy"
  | "VBSEnclave"
  | "PublicTrustTest";

export interface CertificateProfileProps {
  /**
   * Resource group of the parent account. Changing it replaces the profile.
   */
  resourceGroup: string;
  /**
   * Name of the parent Artifact Signing account. Changing it replaces the
   * profile.
   */
  account: string;
  /**
   * Profile name, 5-100 characters of letters, digits, and hyphens,
   * starting with a letter. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the profile.
   */
  name?: string;
  /**
   * Kind of certificate the profile issues. Changing it replaces the
   * profile.
   */
  profileType: CertificateProfileType;
  /**
   * ID of a completed identity validation of the account (created in the
   * Azure portal). Its verified subject fields become the certificate
   * subject name. Changing it replaces the profile.
   */
  identityValidationId: string;
  /**
   * Include STREET in the certificate subject name. Changing it replaces
   * the profile.
   * @default false
   */
  includeStreetAddress?: boolean;
  /**
   * Include L (city) in the certificate subject name. Only for private-trust
   * profile types. Changing it replaces the profile.
   * @default false
   */
  includeCity?: boolean;
  /**
   * Include S (state) in the certificate subject name. Only for
   * private-trust profile types. Changing it replaces the profile.
   * @default false
   */
  includeState?: boolean;
  /**
   * Include C (country) in the certificate subject name. Only for
   * private-trust profile types. Changing it replaces the profile.
   * @default false
   */
  includeCountry?: boolean;
  /**
   * Include PC (postal code) in the certificate subject name. Changing it
   * replaces the profile.
   * @default false
   */
  includePostalCode?: boolean;
}

/** A certificate issued for a profile. */
export interface CertificateProfileCertificate {
  /** Serial number of the certificate. */
  serialNumber?: string;
  /** Subject name of the certificate. */
  subjectName?: string;
  /** SHA-1 thumbprint of the certificate. */
  thumbprint?: string;
  /** Enhanced key usage OID of the certificate. */
  enhancedKeyUsage?: string;
  /** Creation timestamp. */
  createdDate?: string;
  /** Expiry timestamp. */
  expiryDate?: string;
  /** `Active`, `Expired`, or `Revoked`. */
  status?: string;
}

export interface CertificateProfile extends Resource<
  "Azure.CodeSigning.CertificateProfile",
  CertificateProfileProps,
  {
    /** Name of the profile. */
    profileName: string;
    /** Name of the parent account. */
    account: string;
    /** Resource group of the parent account. */
    resourceGroup: string;
    /** ARM resource ID of the profile. */
    profileId: string;
    /** Kind of certificate the profile issues. */
    profileType: string;
    /** Identity validation the subject name comes from. */
    identityValidationId: string;
    /** Profile status: `Active`, `Disabled`, or `Suspended`. */
    status: string;
    /** Certificates issued (and renewed) for the profile. */
    certificates: CertificateProfileCertificate[];
  },
  never,
  Providers
> {}

/**
 * A certificate profile of an Artifact Signing account. A profile binds an
 * identity validation to a certificate type; Microsoft issues and renews
 * short-lived signing certificates for it, which SignTool or the signing
 * GitHub Action use via the account's `accountUri`.
 *
 * Profiles carry no tags and have no update API: every change replaces the
 * profile. Alchemy treats a profile as owned when its parent account carries
 * this stack's and stage's ownership tags. Creating one requires a completed
 * identity validation, which is done in the Azure portal.
 *
 * @see https://learn.microsoft.com/azure/artifact-signing/concept-certificate-management
 *
 * ### Creating a Profile
 * **Example:** Public-trust profile
 * ```typescript
 * const account = yield* Azure.CodeSigning.Account("signing", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const profile = yield* Azure.CodeSigning.CertificateProfile("release", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   profileType: "PublicTrust",
 *   identityValidationId: "00000000-0000-0000-0000-000000000000",
 * });
 * ```
 *
 * **Example:** Private-trust profile for App Control policies
 * ```typescript
 * const profile = yield* Azure.CodeSigning.CertificateProfile("ci-policy", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   profileType: "PrivateTrustCIPolicy",
 *   identityValidationId: validationId,
 *   includeCity: true,
 *   includeCountry: true,
 * });
 * ```
 *
 * @resource
 */
export const CertificateProfile = Resource<CertificateProfile>(
  "Azure.CodeSigning.CertificateProfile",
);

type ObservedProfile = codesigning.GetCertificateProfileResponse;

/** Generate a valid profile name: letters, digits, and hyphens. */
const createProfileName = Effect.fn(function* (id: string) {
  const name = (yield* createPhysicalName({
    id,
    maxLength: 100,
    delimiter: "-",
  }))
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-");
  return /^[a-zA-Z]/.test(name) ? name : `p${name}`.slice(0, 100);
});

const getProfile = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  profileName: string,
) =>
  orUndefinedIfNotFound(
    codesigning.GetCertificateProfile({
      subscriptionId,
      resourceGroupName,
      accountName,
      profileName,
    }),
  );

/** The parent account carries this stack's and stage's ownership tags. */
const parentOwned = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  Effect.gen(function* () {
    const account = yield* getCodeSigningAccount(
      subscriptionId,
      resourceGroupName,
      accountName,
    );
    const { stack, stage } = yield* stackAndStage;
    return (
      account?.tags?.["alchemy::stack"] === stack &&
      account?.tags?.["alchemy::stage"] === stage
    );
  });

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  profile: ObservedProfile,
): CertificateProfile["Attributes"] => ({
  profileName: name,
  account,
  resourceGroup,
  profileId: profile.id ?? "",
  profileType: profile.properties?.profileType ?? "",
  identityValidationId: profile.properties?.identityValidationId ?? "",
  status: profile.properties?.status ?? "",
  certificates: (profile.properties?.certificates ?? []).map((cert) => ({
    serialNumber: cert.serialNumber,
    subjectName: cert.subjectName,
    thumbprint: cert.thumbprint,
    enhancedKeyUsage: cert.enhancedKeyUsage,
    createdDate: cert.createdDate,
    expiryDate: cert.expiryDate,
    status: cert.status,
  })),
});

const bool = (value: boolean | undefined) => value ?? false;

export const CertificateProfileProvider = () =>
  Provider.succeed(CertificateProfile, {
    stables: [
      "profileName",
      "account",
      "resourceGroup",
      "profileId",
      "profileType",
      "identityValidationId",
    ],

    // Profiles are deleted together with their parent account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account.toLowerCase() !== output.account.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.profileName.toLowerCase()) ||
        news.profileType !== output.profileType ||
        news.identityValidationId.toLowerCase() !==
          output.identityValidationId.toLowerCase() ||
        (olds !== undefined &&
          (bool(news.includeStreetAddress) !==
            bool(olds.includeStreetAddress) ||
            bool(news.includeCity) !== bool(olds.includeCity) ||
            bool(news.includeState) !== bool(olds.includeState) ||
            bool(news.includeCountry) !== bool(olds.includeCountry) ||
            bool(news.includePostalCode) !== bool(olds.includePostalCode)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its account.
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.profileName ?? olds?.name ?? (yield* createProfileName(id));
      const observed = yield* getProfile(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* parentOwned(subscriptionId, resourceGroup, account))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CodeSigning");
      const resourceGroup = news.resourceGroup;
      const account = news.account;
      const name =
        news.name ?? output?.profileName ?? (yield* createProfileName(id));
      const get = getProfile(subscriptionId, resourceGroup, account, name);

      // Observe.
      const observed = yield* get;

      // Ensure. Profiles have no update API; every property is
      // creation-only (diff replaces on change), so there is nothing to sync.
      if (observed === undefined) {
        yield* codesigning.CreateCertificateProfile({
          subscriptionId,
          resourceGroupName: resourceGroup,
          accountName: account,
          profileName: name,
          properties: {
            profileType: news.profileType,
            identityValidationId: news.identityValidationId,
            includeStreetAddress: news.includeStreetAddress,
            includeCity: news.includeCity,
            includeState: news.includeState,
            includeCountry: news.includeCountry,
            includePostalCode: news.includePostalCode,
          },
        });
      }
      const ready = yield* waitForProvisioned(
        `certificate profile ${name}`,
        get,
        (profile) => profile.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      return toAttrs(resourceGroup, account, name, ready);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        codesigning.DeleteCertificateProfile({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.account,
          profileName: output.profileName,
        }),
      );
      yield* waitUntilGone(
        `certificate profile ${output.profileName}`,
        getProfile(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.profileName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.CodeSigning.Account"],
    },
  });
