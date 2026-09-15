import * as androidmanagement from "@distilled.cloud/gcp/androidmanagement_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  findOwnedEnterprise,
  getEnterprise,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  listOwnedEnterprises,
  MAX_DISPLAY_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameStringList,
  sameText,
  toDisplayName,
  toEnterpriseName,
  updateMaskOf,
} from "./internal.ts";

export type EnterpriseProps = {
  /**
   * Cloud project that owns the enterprise. Defaults to the stack
   * project. Immutable — changing it replaces the enterprise.
   */
  projectId?: string;
  /**
   * Signup URL name from `signupUrls.create`. Set with
   * `enterpriseToken` for a customer-managed enterprise.
   */
  signupUrlName?: string;
  /**
   * Enterprise token appended to the signup callback URL. Set with
   * `signupUrlName` for a customer-managed enterprise.
   */
  enterpriseToken?: string;
  /**
   * Whether the admin accepted the managed Google Play Agreement.
   * Required for EMM-managed enterprises; must be omitted for
   * customer-managed ones.
   * @default true when `signupUrlName` is omitted
   */
  agreementAccepted?: boolean;
  /**
   * Display name shown to users (max 100 characters). Enterprises have
   * no labels field, so Alchemy stores ownership in a `[alchemy …]`
   * prefix and strips it from attributes.
   */
  enterpriseDisplayName?: string;
  /**
   * Predominant UI color as `(red << 16) | (green << 8) | blue`.
   */
  primaryColor?: number;
  /**
   * Pub/Sub topic for enterprise notifications
   * (`projects/{project}/topics/{topic}`).
   */
  pubsubTopic?: string;
  /**
   * Enabled Pub/Sub notification types (`ENROLLMENT`, `COMMAND`, …).
   */
  enabledNotificationTypes?: Array<
    androidmanagement.EnterpriseEnabledNotificationTypesItemEnum | (string & {})
  >;
  /**
   * Logo shown during device provisioning.
   */
  logo?: androidmanagement.ExternalData;
  /**
   * Terms and conditions pages shown during provisioning.
   */
  termsAndConditions?: androidmanagement.TermsAndConditionsList;
  /**
   * Sign-in details used for custom enrollment.
   */
  signinDetails?: androidmanagement.SigninDetailList;
  /**
   * Contact info for an EMM-managed enterprise.
   */
  contactInfo?: androidmanagement.ContactInfo;
};

export type Enterprise = Resource<
  "GCP.Androidmanagement.Enterprise",
  EnterpriseProps,
  {
    /** Resource name `enterprises/{enterprise}`. */
    name: string;
    /** Enterprise id (last path segment). */
    enterpriseId: string;
    /** Project id used when the enterprise was reconciled. */
    project: string;
    /** Display name with the Alchemy ownership prefix stripped. */
    enterpriseDisplayName: string | undefined;
    /** Predominant UI color. */
    primaryColor: number | undefined;
    /** Pub/Sub topic for notifications. */
    pubsubTopic: string | undefined;
    /** Enabled notification types. */
    enabledNotificationTypes: string[] | undefined;
    /** Provisioning logo. */
    logo: androidmanagement.ExternalData | undefined;
    /** Terms and conditions. */
    termsAndConditions: androidmanagement.TermsAndConditionsList | undefined;
    /** Sign-in details. */
    signinDetails: androidmanagement.SigninDetailList | undefined;
    /** Contact info. */
    contactInfo: androidmanagement.ContactInfo | undefined;
    /** Enterprise type. */
    enterpriseType: string | undefined;
    /** Managed Google Play Accounts enterprise type. */
    managedGooglePlayAccountsEnterpriseType: string | undefined;
    /** Managed Google domain type. */
    managedGoogleDomainType: string | undefined;
    /** Google authentication settings. */
    googleAuthenticationSettings:
      | androidmanagement.GoogleAuthenticationSettings
      | undefined;
  },
  never,
  Providers
>;

/**
 * An Android Management API enterprise.
 *
 * Enterprises have no labels field, so Alchemy stamps ownership into
 * `enterpriseDisplayName` for `list` / nuke. Customer-managed
 * enterprises need `signupUrlName` plus `enterpriseToken`; otherwise an
 * EMM-managed enterprise is created with `agreementAccepted`. Display
 * name, color, notifications, logo, terms, sign-in details, and contact
 * info update in place. Changing `projectId` replaces the enterprise.
 * `enterprises.delete` only works for EMM-managed enterprises.
 *
 * ### Creating an Enterprise
 * **Example:** EMM-managed enterprise
 * ```typescript
 * const enterprise = yield* GCP.Androidmanagement.Enterprise("Work", {
 *   enterpriseDisplayName: "Alchemy Work",
 * });
 * ```
 *
 * **Example:** Customer-managed after signup
 * ```typescript
 * const enterprise = yield* GCP.Androidmanagement.Enterprise("Work", {
 *   signupUrlName: "signupUrls/abc",
 *   enterpriseToken: token,
 *   enterpriseDisplayName: "Acme",
 * });
 * ```
 *
 * ### Updating an Enterprise
 * **Example:** Rename
 * ```typescript
 * const enterprise = yield* GCP.Androidmanagement.Enterprise("Work", {
 *   enterpriseDisplayName: "Alchemy Work 2026",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Androidmanagement
 */
export const Enterprise = Resource<Enterprise>(
  "GCP.Androidmanagement.Enterprise",
);

export class EnterpriseNotResolved extends Data.TaggedError(
  "GCP.Androidmanagement.EnterpriseNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (enterprise: androidmanagement.Enterprise, project: string) => {
  const name = enterprise.name ?? "";
  return {
    name,
    enterpriseId: lastSegment(name),
    project,
    enterpriseDisplayName: parseOwnership(enterprise.enterpriseDisplayName)
      .text,
    primaryColor: enterprise.primaryColor,
    pubsubTopic: enterprise.pubsubTopic,
    enabledNotificationTypes: enterprise.enabledNotificationTypes,
    logo: enterprise.logo,
    termsAndConditions: enterprise.termsAndConditions,
    signinDetails: enterprise.signinDetails,
    contactInfo: enterprise.contactInfo,
    enterpriseType: enterprise.enterpriseType,
    managedGooglePlayAccountsEnterpriseType:
      enterprise.managedGooglePlayAccountsEnterpriseType,
    managedGoogleDomainType: enterprise.managedGoogleDomainType,
    googleAuthenticationSettings: enterprise.googleAuthenticationSettings,
  };
};

const desiredBody = (input: {
  displayName: string;
  news: EnterpriseProps;
}): androidmanagement.Enterprise => ({
  enterpriseDisplayName: input.displayName,
  primaryColor: input.news.primaryColor,
  pubsubTopic: input.news.pubsubTopic,
  enabledNotificationTypes: input.news.enabledNotificationTypes,
  logo: input.news.logo,
  termsAndConditions: input.news.termsAndConditions,
  signinDetails: input.news.signinDetails,
  contactInfo: input.news.contactInfo,
});

export const EnterpriseProvider = () =>
  Provider.succeed(Enterprise, {
    stables: ["name", "enterpriseId", "project", "enterpriseType"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousProject = olds?.projectId ?? output?.project;
      if (
        news.projectId !== undefined &&
        previousProject !== undefined &&
        news.projectId !== previousProject
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const projectId = olds?.projectId ?? output?.project ?? env.project;
      let existing = yield* getEnterprise(
        output?.name ?? toEnterpriseName(output?.enterpriseId ?? ""),
      );
      if (existing === undefined) {
        existing = yield* findOwnedEnterprise(id, projectId);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, projectId);
      return (yield* ownedByAlchemy(id, existing.enterpriseDisplayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const enterprises = yield* listOwnedEnterprises(env.project);
        return enterprises
          .filter((enterprise) =>
            hasOwnershipMarker(enterprise.enterpriseDisplayName),
          )
          .map((enterprise) => toAttrs(enterprise, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const projectId = news.projectId ?? output?.project ?? env.project;
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        yield* toDisplayName(
          id,
          news.enterpriseDisplayName,
          output?.enterpriseDisplayName,
        ),
        MAX_DISPLAY_NAME_LENGTH,
      );
      const desired = desiredBody({ displayName, news });
      const customerManaged =
        (news.signupUrlName !== undefined && news.signupUrlName.length > 0) ||
        (news.enterpriseToken !== undefined && news.enterpriseToken.length > 0);

      let current = yield* getEnterprise(
        output?.name ?? toEnterpriseName(output?.enterpriseId ?? ""),
      );
      if (current === undefined) {
        current = yield* findOwnedEnterprise(id, projectId);
      }

      if (current === undefined) {
        const created = yield* androidmanagement
          .createEnterprises({
            projectId,
            signupUrlName: news.signupUrlName,
            enterpriseToken: news.enterpriseToken,
            agreementAccepted: customerManaged
              ? news.agreementAccepted
              : (news.agreementAccepted ?? true),
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedEnterprise(id, projectId),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new EnterpriseNotResolved({
          name: output?.name ?? displayName,
        });
      }

      const name = current.name ?? output?.name ?? "";
      const displayChanged = !sameText(
        current.enterpriseDisplayName,
        displayName,
      );
      const colorChanged =
        news.primaryColor !== undefined &&
        current.primaryColor !== news.primaryColor;
      const topicChanged =
        news.pubsubTopic !== undefined &&
        !sameText(current.pubsubTopic, news.pubsubTopic);
      const notificationsChanged =
        news.enabledNotificationTypes !== undefined &&
        !sameStringList(
          current.enabledNotificationTypes,
          news.enabledNotificationTypes,
        );
      const logoChanged =
        news.logo !== undefined && !jsonEqual(current.logo, news.logo);
      const termsChanged =
        news.termsAndConditions !== undefined &&
        !jsonEqual(current.termsAndConditions, news.termsAndConditions);
      const signinChanged =
        news.signinDetails !== undefined &&
        !jsonEqual(current.signinDetails, news.signinDetails);
      const contactChanged =
        news.contactInfo !== undefined &&
        !jsonEqual(current.contactInfo, news.contactInfo);

      const updateMask = updateMaskOf(
        displayChanged ? "enterpriseDisplayName" : undefined,
        colorChanged ? "primaryColor" : undefined,
        topicChanged ? "pubsubTopic" : undefined,
        notificationsChanged ? "enabledNotificationTypes" : undefined,
        logoChanged ? "logo" : undefined,
        termsChanged ? "termsAndConditions" : undefined,
        signinChanged ? "signinDetails" : undefined,
        contactChanged ? "contactInfo" : undefined,
      );

      if (updateMask.length > 0 && name.length > 0) {
        current = yield* androidmanagement.patchEnterprises({
          name,
          updateMask,
          body: desired,
        });
      }

      const fresh = (yield* getEnterprise(name)) ?? current;
      return toAttrs(fresh, projectId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      yield* androidmanagement.deleteEnterprises({ name: output.name }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("Forbidden", () => Effect.void),
        Effect.catchTag("BadRequest", () => Effect.void),
      );
    }),
  });
