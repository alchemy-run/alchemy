import * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  findAdvertiserByDisplayName,
  hasOwnershipMarker,
  jsonEqual,
  listAdvertisers,
  ownedByAlchemy,
  parseOwnership,
  partnerIdFromEnv,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./ownership.ts";

export type AdvertiserBillingConfig = {
  /** Billing profile assigned to the advertiser. */
  billingProfileId?: string;
};

export type AdvertiserThirdPartyOnlyConfig = {
  /**
   * Whether order ID reporting for pixels is enabled. Cannot be unset
   * once true.
   */
  pixelOrderIdReportingEnabled?: boolean;
};

export type AdvertiserCmHybridConfig = {
  /** Include DV360 data in CM360 data transfer reports. */
  dv360ToCmDataSharingEnabled?: boolean;
  /** CM360 Floodlight account id. Immutable. */
  cmAccountId?: string;
  /** CM360 Floodlight configuration id. Immutable. */
  cmFloodlightConfigId?: string;
  /** CM360 sites whose placements sync as DV360 creatives. */
  cmSyncableSiteIds?: string[];
  /** Report DV360 cost to CM360. */
  dv360ToCmCostReportingEnabled?: boolean;
  /** Authorize sharing Floodlight configuration with this advertiser. */
  cmFloodlightLinkingAuthorized?: boolean;
};

export type AdvertiserAdServerConfig = {
  /** CM360 hybrid ad-server settings. */
  cmHybridConfig?: AdvertiserCmHybridConfig;
  /** Third-party-only ad-server settings. */
  thirdPartyOnlyConfig?: AdvertiserThirdPartyOnlyConfig;
};

export type AdvertiserCreativeConfig = {
  /** Disable Google About this Ad badging. */
  obaComplianceDisabled?: boolean;
  /** Integral Ad Service campaign-monitor client id. */
  iasClientId?: string;
  /** Enable dynamic creatives. */
  dynamicCreativeEnabled?: boolean;
  /** Authorize TV campaign reporting from video creatives. */
  videoCreativeDataSharingAuthorized?: boolean;
};

export type AdvertiserGeneralConfig = {
  /**
   * Domain URL of the advertiser primary website (`http:` or `https:`,
   * no path). Immutable currency is set alongside this on create.
   */
  domainUrl?: string;
  /**
   * Advertiser currency as ISO 4217. Immutable.
   * @default "USD"
   */
  currencyCode?: string;
};

export type AdvertiserServingConfig = {
  /** Exempt connected TV from viewability targeting. */
  exemptTvFromViewabilityTargeting?: boolean;
};

export type AdvertiserSdfConfig = {
  /** SDF version, for example `SDF_VERSION_9_2`. */
  version?: string;
  /** Administrator email for SDF processing reports. */
  adminEmail?: string;
};

export type AdvertiserDataAccessConfig = {
  /** Override partner SDF settings. */
  sdfConfig?: {
    overridePartnerSdfConfig?: boolean;
    sdfConfig?: AdvertiserSdfConfig;
  };
};

export type AdvertiserProps = {
  /**
   * Partner that owns the advertiser. Immutable — changing it replaces
   * the advertiser.
   */
  partnerId: string;
  /**
   * System-assigned advertiser id. Omit on create; pass the observed id
   * to update in place.
   */
  advertiserId?: string;
  /**
   * Display name (max 240 bytes). DV360 advertisers have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * in `integrationDetails.integrationCode`.
   */
  displayName?: string;
  /**
   * Serving status. Create accepts `ENTITY_STATUS_ACTIVE`,
   * `ENTITY_STATUS_PAUSED`, and `ENTITY_STATUS_SCHEDULED_FOR_DELETION`.
   * @default "ENTITY_STATUS_ACTIVE"
   */
  entityStatus?: string;
  /**
   * Billing profile assigned to the advertiser.
   */
  billingProfileId: string;
  /**
   * Ad-server configuration. Defaults to third-party-only. Immutable
   * after create.
   */
  adServerConfig?: AdvertiserAdServerConfig;
  /**
   * Creative-related settings.
   */
  creativeConfig?: AdvertiserCreativeConfig;
  /**
   * Domain URL and currency. Currency is immutable.
   */
  generalConfig: AdvertiserGeneralConfig;
  /**
   * Viewability targeting exemptions.
   */
  servingConfig?: AdvertiserServingConfig;
  /**
   * Whether line items serve EU political ads.
   * @default "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING"
   */
  containsEuPoliticalAds?: string;
  /**
   * Enable Mediaocean Prisma budget integration.
   * @default false
   */
  prismaEnabled?: boolean;
  /**
   * SDF and data-access settings.
   */
  dataAccessConfig?: AdvertiserDataAccessConfig;
  /**
   * Caller integration code. Alchemy ownership is prefixed automatically.
   */
  integrationCode?: string;
};

export type Advertiser = Resource<
  "GCP.Displayvideo.Advertiser",
  AdvertiserProps,
  {
    /** Resource name `advertisers/{advertiser}`. */
    name: string;
    /** System-assigned advertiser id. */
    advertiserId: string;
    /** Partner id. */
    partnerId: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Serving status. */
    entityStatus: string | undefined;
    /** Billing profile id. */
    billingProfileId: string | undefined;
    /** Ad-server configuration. */
    adServerConfig: AdvertiserAdServerConfig | undefined;
    /** Creative settings. */
    creativeConfig: AdvertiserCreativeConfig | undefined;
    /** Domain URL, currency, and time zone. */
    generalConfig: {
      domainUrl: string | undefined;
      currencyCode: string | undefined;
      timeZone: string | undefined;
    };
    /** Viewability targeting exemptions. */
    servingConfig: AdvertiserServingConfig | undefined;
    /** EU political advertising status. */
    containsEuPoliticalAds: string | undefined;
    /** Prisma integration flag. */
    prismaEnabled: boolean;
    /** Data-access settings. */
    dataAccessConfig: AdvertiserDataAccessConfig | undefined;
    /** User integration code with ownership stripped. */
    integrationCode: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Display and Video 360 advertiser.
 *
 * Advertisers have no labels field — Alchemy stamps ownership into the
 * display name and `integrationCode` so `list` / nuke can find them.
 * `partnerId` and currency are immutable. Status, domain URL, billing
 * profile, and creative settings update in place. Creating an advertiser
 * requires a DV360 partner and billing profile.
 *
 * ### Creating an Advertiser
 * **Example:** Third-party-only advertiser
 * ```typescript
 * const advertiser = yield* GCP.Displayvideo.Advertiser("Brand", {
 *   partnerId: "123",
 *   billingProfileId: "456",
 *   displayName: "example-brand",
 *   generalConfig: {
 *     domainUrl: "https://example.com",
 *     currencyCode: "USD",
 *   },
 * });
 * ```
 *
 * ### Updating an Advertiser
 * **Example:** Pause serving
 * ```typescript
 * const advertiser = yield* GCP.Displayvideo.Advertiser("Brand", {
 *   partnerId: existing.partnerId,
 *   advertiserId: existing.advertiserId,
 *   billingProfileId: existing.billingProfileId ?? "456",
 *   displayName: "example-brand",
 *   entityStatus: "ENTITY_STATUS_PAUSED",
 *   generalConfig: {
 *     domainUrl: "https://example.com",
 *     currencyCode: "USD",
 *   },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const Advertiser = Resource<Advertiser>("GCP.Displayvideo.Advertiser");

export class AdvertiserNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.AdvertiserNotResolved",
)<{
  advertiserId: string;
}> {}

const DEFAULT_STATUS = "ENTITY_STATUS_ACTIVE";
const DEFAULT_EU = "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING";
const DEFAULT_CURRENCY = "USD";

const adServerOf = (
  config: dv.AdvertiserAdServerConfig | undefined,
): AdvertiserAdServerConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    cmHybridConfig: config.cmHybridConfig
      ? {
          dv360ToCmDataSharingEnabled:
            config.cmHybridConfig.dv360ToCmDataSharingEnabled,
          cmAccountId: config.cmHybridConfig.cmAccountId,
          cmFloodlightConfigId: config.cmHybridConfig.cmFloodlightConfigId,
          cmSyncableSiteIds: config.cmHybridConfig.cmSyncableSiteIds,
          dv360ToCmCostReportingEnabled:
            config.cmHybridConfig.dv360ToCmCostReportingEnabled,
          cmFloodlightLinkingAuthorized:
            config.cmHybridConfig.cmFloodlightLinkingAuthorized,
        }
      : undefined,
    thirdPartyOnlyConfig: config.thirdPartyOnlyConfig
      ? {
          pixelOrderIdReportingEnabled:
            config.thirdPartyOnlyConfig.pixelOrderIdReportingEnabled,
        }
      : undefined,
  };
};

const desiredAdServer = (
  config: AdvertiserAdServerConfig | undefined,
): dv.AdvertiserAdServerConfig => config ?? { thirdPartyOnlyConfig: {} };

const toAttrs = (advertiser: dv.Advertiser) => {
  const parsedName = parseOwnership(advertiser.displayName);
  const parsedCode = parseOwnership(
    advertiser.integrationDetails?.integrationCode,
  );
  return {
    name: advertiser.name ?? "",
    advertiserId: advertiser.advertiserId ?? "",
    partnerId: advertiser.partnerId ?? "",
    displayName: parsedName.text,
    entityStatus: advertiser.entityStatus,
    billingProfileId: advertiser.billingConfig?.billingProfileId,
    adServerConfig: adServerOf(advertiser.adServerConfig),
    creativeConfig: advertiser.creativeConfig,
    generalConfig: {
      domainUrl: advertiser.generalConfig?.domainUrl,
      currencyCode: advertiser.generalConfig?.currencyCode,
      timeZone: advertiser.generalConfig?.timeZone,
    },
    servingConfig: advertiser.servingConfig,
    containsEuPoliticalAds: advertiser.containsEuPoliticalAds,
    prismaEnabled: advertiser.prismaEnabled === true,
    dataAccessConfig: advertiser.dataAccessConfig,
    integrationCode: parsedCode.text,
    updateTime: advertiser.updateTime,
  };
};

const getById = (advertiserId: string | undefined) =>
  !advertiserId
    ? Effect.succeed(undefined)
    : dv
        .getAdvertisers({ advertiserId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const ownershipText = (advertiser: dv.Advertiser) =>
  advertiser.displayName ?? advertiser.integrationDetails?.integrationCode;

export const AdvertiserProvider = () =>
  Provider.succeed(Advertiser, {
    stables: ["name", "advertiserId", "partnerId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousPartner = olds?.partnerId ?? output?.partnerId;
      if (previousPartner !== undefined && news.partnerId !== previousPartner) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.advertiserId ?? output?.advertiserId;
      if (
        previousId !== undefined &&
        news.advertiserId !== undefined &&
        news.advertiserId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const advertiserId = newsOrOutputId(
        olds?.advertiserId,
        output?.advertiserId,
      );
      let existing = yield* getById(advertiserId ?? output?.advertiserId);
      if (existing === undefined) {
        const partnerId =
          olds?.partnerId ?? output?.partnerId ?? partnerIdFromEnv();
        if (partnerId) {
          const ownership = yield* createInternalLabels(id);
          existing = yield* findAdvertiserByDisplayName(
            partnerId,
            encodeOwnershipLine(ownership, olds?.displayName),
          );
        }
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* ownedByAlchemy(id, ownershipText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const partnerId = partnerIdFromEnv();
        if (!partnerId) return [];
        const advertisers = yield* listAdvertisers(partnerId);
        return advertisers
          .filter((advertiser) => hasOwnershipMarker(ownershipText(advertiser)))
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const partnerId = news.partnerId;
      const ownership = yield* createInternalLabels(id);
      const userName = yield* toDisplayName(
        id,
        news.displayName,
        parseOwnership(output?.displayName).text,
      );
      const displayName = encodeOwnershipLine(ownership, userName);
      const integrationCode = encodeOwnershipLine(
        ownership,
        news.integrationCode,
        500,
      );
      const entityStatus = news.entityStatus ?? DEFAULT_STATUS;
      const containsEuPoliticalAds = news.containsEuPoliticalAds ?? DEFAULT_EU;
      const prismaEnabled = news.prismaEnabled === true;
      const adServerConfig = desiredAdServer(news.adServerConfig);
      const generalConfig = {
        domainUrl: news.generalConfig.domainUrl,
        currencyCode: news.generalConfig.currencyCode ?? DEFAULT_CURRENCY,
      };
      const billingConfig = { billingProfileId: news.billingProfileId };
      const creativeConfig = news.creativeConfig ?? {};

      let current = yield* getById(news.advertiserId ?? output?.advertiserId);
      if (current === undefined) {
        current = yield* findAdvertiserByDisplayName(partnerId, displayName);
      }

      if (current === undefined) {
        const created = yield* dv
          .createAdvertisers({
            body: {
              partnerId,
              displayName,
              entityStatus,
              billingConfig,
              adServerConfig,
              creativeConfig,
              generalConfig,
              servingConfig: news.servingConfig,
              containsEuPoliticalAds,
              prismaEnabled,
              dataAccessConfig: news.dataAccessConfig,
              integrationDetails: { integrationCode },
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findAdvertiserByDisplayName(partnerId, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AdvertiserNotResolved({
          advertiserId:
            news.advertiserId ?? output?.advertiserId ?? displayName,
        });
      }

      const advertiserId = current.advertiserId ?? "";
      const displayChanged = (current.displayName ?? "") !== displayName;
      const statusChanged = (current.entityStatus ?? "") !== entityStatus;
      const billingChanged =
        (current.billingConfig?.billingProfileId ?? "") !==
        news.billingProfileId;
      const domainChanged =
        (current.generalConfig?.domainUrl ?? "") !==
        (generalConfig.domainUrl ?? "");
      const creativeChanged = !jsonEqual(
        current.creativeConfig ?? {},
        creativeConfig,
      );
      const servingChanged = !jsonEqual(
        current.servingConfig,
        news.servingConfig,
      );
      const euChanged =
        (current.containsEuPoliticalAds ?? "") !== containsEuPoliticalAds;
      const prismaChanged = (current.prismaEnabled === true) !== prismaEnabled;
      const accessChanged = !jsonEqual(
        current.dataAccessConfig,
        news.dataAccessConfig,
      );
      const codeChanged = !sameText(
        current.integrationDetails?.integrationCode,
        integrationCode,
      );

      if (
        displayChanged ||
        statusChanged ||
        billingChanged ||
        domainChanged ||
        creativeChanged ||
        servingChanged ||
        euChanged ||
        prismaChanged ||
        accessChanged ||
        codeChanged
      ) {
        current = yield* dv.patchAdvertisers({
          advertiserId,
          updateMask: updateMaskOf(
            displayChanged ? "displayName" : undefined,
            statusChanged ? "entityStatus" : undefined,
            billingChanged ? "billingConfig" : undefined,
            domainChanged ? "generalConfig.domainUrl" : undefined,
            creativeChanged ? "creativeConfig" : undefined,
            servingChanged ? "servingConfig" : undefined,
            euChanged ? "containsEuPoliticalAds" : undefined,
            prismaChanged ? "prismaEnabled" : undefined,
            accessChanged ? "dataAccessConfig" : undefined,
            codeChanged ? "integrationDetails" : undefined,
          ),
          body: {
            advertiserId,
            partnerId,
            displayName,
            entityStatus,
            billingConfig,
            creativeConfig,
            generalConfig,
            servingConfig: news.servingConfig,
            containsEuPoliticalAds,
            prismaEnabled,
            dataAccessConfig: news.dataAccessConfig,
            integrationDetails: { integrationCode },
          },
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.advertiserId) return;
      yield* dv
        .deleteAdvertisers({ advertiserId: output.advertiserId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

const newsOrOutputId = (
  newsId: string | undefined,
  outputId: string | undefined,
) => newsId ?? outputId;
