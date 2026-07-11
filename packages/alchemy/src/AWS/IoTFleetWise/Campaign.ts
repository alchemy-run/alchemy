import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  durationToSeconds,
  inFleetWiseRegion,
  readFleetWiseTags,
  retryObservation,
  stableEquals,
  syncFleetWiseTags,
  toFleetWiseTagList,
} from "./internal.ts";

export interface CampaignProps {
  /**
   * Name of the campaign. Must be 1-100 characters of `[a-zA-Z0-9:_-]`.
   * If omitted, a deterministic physical name is generated. Changing the
   * name replaces the campaign.
   */
  campaignName?: string;
  /**
   * Human-readable description of the campaign. Updated in place.
   */
  description?: string;
  /**
   * ARN of the {@link SignalCatalog} the collected signals come from.
   * Changing it replaces the campaign.
   */
  signalCatalogArn: string;
  /**
   * ARN of the {@link Fleet} or {@link Vehicle} the campaign deploys to.
   * Changing it replaces the campaign.
   */
  targetArn: string;
  /**
   * When to collect data — a time-based or condition-based scheme.
   * Changing it replaces the campaign.
   */
  collectionScheme: iotfleetwise.CollectionScheme;
  /**
   * Signals to collect from vehicles. Changing them replaces the
   * campaign.
   */
  signalsToCollect?: iotfleetwise.SignalInformation[];
  /**
   * Destinations (S3, Timestream or MQTT topic) the collected data is
   * delivered to. Changing them replaces the campaign.
   */
  dataDestinationConfigs?: iotfleetwise.DataDestinationConfig[];
  /**
   * Time the campaign starts collecting data, as an ISO-8601 string.
   * Changing it replaces the campaign.
   * @default now
   */
  startTime?: string;
  /**
   * Time the campaign expires, as an ISO-8601 string. Changing it
   * replaces the campaign.
   * @default 253402214400 (9999-12-31)
   */
  expiryTime?: string;
  /**
   * How long to keep collecting data after a condition-based trigger
   * fires, e.g. `"30 seconds"` or `Duration.seconds(30)`. Sent to
   * FleetWise as whole seconds (a bare number is milliseconds).
   * Changing it replaces the campaign.
   * @default 0
   */
  postTriggerCollectionDuration?: Duration.Input;
  /**
   * Whether to send active diagnostic trouble codes — `"OFF"` or
   * `"SEND_ACTIVE_DTCS"`. Changing it replaces the campaign.
   * @default "OFF"
   */
  diagnosticsMode?: iotfleetwise.DiagnosticsMode;
  /**
   * Whether to store collected data offline when a vehicle lacks
   * connectivity — `"OFF"` or `"TO_DISK"`. Changing it replaces the
   * campaign.
   * @default "OFF"
   */
  spoolingMode?: iotfleetwise.SpoolingMode;
  /**
   * Whether to compress vehicle-to-cloud transmissions — `"OFF"` or
   * `"SNAPPY"`. Changing it replaces the campaign.
   * @default "OFF"
   */
  compression?: iotfleetwise.Compression;
  /**
   * Vehicle attribute node paths added as extra dimensions on the
   * collected data, e.g. `["Vehicle.VIN"]`. Updated in place.
   */
  dataExtraDimensions?: string[];
  /**
   * Data partitions for on-vehicle storage (requires spooling to disk).
   * Changing them replaces the campaign.
   */
  dataPartitions?: iotfleetwise.DataPartition[];
  /**
   * Signals fetched on demand by actuator-triggered fetch configs.
   * Changing them replaces the campaign.
   */
  signalsToFetch?: iotfleetwise.SignalFetchInformation[];
  /**
   * Whether the provider approves the campaign (transitioning it from
   * `WAITING_FOR_APPROVAL` to `RUNNING`) after creation.
   * @default false
   */
  autoApprove?: boolean;
  /**
   * User-defined tags for the campaign.
   */
  tags?: Record<string, string>;
}

export interface Campaign extends Resource<
  "AWS.IoTFleetWise.Campaign",
  CampaignProps,
  {
    /** The name of the campaign. */
    campaignName: string;
    /** The ARN of the campaign. */
    campaignArn: string;
    /** The current status of the campaign (`RUNNING`, `SUSPENDED`, ...). */
    status: string;
    /** The signal catalog the campaign collects from. */
    signalCatalogArn: string | undefined;
    /** The fleet or vehicle the campaign targets. */
    targetArn: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS IoT FleetWise campaign — the orchestration of data-collection
 * rules that the Edge Agent uses to decide which signals to collect from
 * a {@link Fleet} or {@link Vehicle} and where to deliver them.
 *
 * Campaigns are created in `WAITING_FOR_APPROVAL` status; set
 * `autoApprove: true` to have the provider approve them into `RUNNING`.
 * Only the description and extra dimensions are mutable — every other
 * change replaces the campaign. AWS IoT FleetWise is allowlist-gated and
 * offered in `us-east-1`/`eu-central-1` only.
 * @resource
 * @section Creating a Campaign
 * @example Time-Based Collection to S3
 * ```typescript
 * const campaign = yield* Campaign("SpeedTelemetry", {
 *   signalCatalogArn: catalog.signalCatalogArn,
 *   targetArn: fleet.fleetArn,
 *   collectionScheme: {
 *     timeBasedCollectionScheme: { periodMs: 10_000 },
 *   },
 *   signalsToCollect: [{ name: "Vehicle.Speed" }],
 *   dataDestinationConfigs: [
 *     { s3Config: { bucketArn: bucket.bucketArn } },
 *   ],
 *   autoApprove: true,
 * });
 * ```
 */
export const Campaign = Resource<Campaign>("AWS.IoTFleetWise.Campaign");

export const CampaignProvider = () =>
  Provider.effect(
    Campaign,
    Effect.gen(function* () {
      const toName = (id: string, props: { campaignName?: string }) =>
        props.campaignName
          ? Effect.succeed(props.campaignName)
          : createPhysicalName({ id, maxLength: 100 });

      const readCampaign = Effect.fn(function* (name: string) {
        return yield* iotfleetwise.getCampaign({ name }).pipe(
          inFleetWiseRegion,
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      // Campaign provisioning is asynchronous (status CREATING). Bounded
      // wait until the service settles it into an actionable status.
      const waitUntilSettled = Effect.fn(function* (name: string) {
        return yield* readCampaign(name).pipe(
          Effect.flatMap((campaign) => {
            if (campaign === undefined) {
              return Effect.fail(new Error(`Campaign '${name}' not found`));
            }
            if (campaign.status === "CREATING") {
              return Effect.fail(
                new Error(`Campaign '${name}' still creating`),
              );
            }
            return Effect.succeed(campaign);
          }),
          retryObservation,
        );
      });

      const toAttrs = Effect.fn(function* (
        campaign: iotfleetwise.GetCampaignResponse,
      ) {
        if (campaign.name === undefined || campaign.arn === undefined) {
          return yield* Effect.fail(
            new Error(`Campaign '${campaign.name}' is missing its ARN`),
          );
        }
        return {
          campaignName: campaign.name,
          campaignArn: campaign.arn,
          status: campaign.status ?? "CREATING",
          signalCatalogArn: campaign.signalCatalogArn,
          targetArn: campaign.targetArn,
        };
      });

      return {
        stables: ["campaignName", "campaignArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* toName(id, olds)) !== (yield* toName(id, news))) {
            return { action: "replace" } as const;
          }
          // Only description and dataExtraDimensions are mutable; every
          // other property is fixed at creation.
          const createOnly = (props: CampaignProps) => ({
            signalCatalogArn: props.signalCatalogArn,
            targetArn: props.targetArn,
            collectionScheme: props.collectionScheme,
            signalsToCollect: props.signalsToCollect,
            dataDestinationConfigs: props.dataDestinationConfigs,
            startTime: props.startTime,
            expiryTime: props.expiryTime,
            postTriggerCollectionDuration: durationToSeconds(
              props.postTriggerCollectionDuration,
            ),
            diagnosticsMode: props.diagnosticsMode,
            spoolingMode: props.spoolingMode,
            compression: props.compression,
            dataPartitions: props.dataPartitions,
            signalsToFetch: props.signalsToFetch,
          });
          if (!stableEquals(createOnly(olds), createOnly(news))) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.campaignName ?? (yield* toName(id, olds ?? {}));
          const found = yield* readCampaign(name);
          if (found?.arn === undefined) return undefined;
          const attrs = yield* toAttrs(found);
          const tags = yield* readFleetWiseTags(found.arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.campaignName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readCampaign(name);

          // 2. Ensure — create if missing; tolerate the AlreadyExists race.
          if (observed === undefined) {
            yield* iotfleetwise
              .createCampaign({
                name,
                description: news.description,
                signalCatalogArn: news.signalCatalogArn,
                targetArn: news.targetArn,
                collectionScheme: news.collectionScheme,
                signalsToCollect: news.signalsToCollect,
                dataDestinationConfigs: news.dataDestinationConfigs,
                startTime:
                  news.startTime !== undefined
                    ? new Date(news.startTime)
                    : undefined,
                expiryTime:
                  news.expiryTime !== undefined
                    ? new Date(news.expiryTime)
                    : undefined,
                postTriggerCollectionDuration: durationToSeconds(
                  news.postTriggerCollectionDuration,
                ),
                diagnosticsMode: news.diagnosticsMode,
                spoolingMode: news.spoolingMode,
                compression: news.compression,
                dataExtraDimensions: news.dataExtraDimensions,
                dataPartitions: news.dataPartitions,
                signalsToFetch: news.signalsToFetch,
                tags: toFleetWiseTagList(desiredTags),
              })
              .pipe(
                inFleetWiseRegion,
                Effect.catchTag("ConflictException", () => Effect.void),
              );
          }
          observed = yield* waitUntilSettled(name);

          // 3. Sync mutable aspects — description / dataExtraDimensions via
          //    the UPDATE action, applied only on an observed delta.
          const descriptionChanged =
            news.description !== undefined &&
            news.description !== observed.description;
          const dimensionsChanged =
            news.dataExtraDimensions !== undefined &&
            !stableEquals(
              observed.dataExtraDimensions ?? [],
              news.dataExtraDimensions,
            );
          if (descriptionChanged || dimensionsChanged) {
            yield* iotfleetwise
              .updateCampaign({
                name,
                action: "UPDATE",
                description: descriptionChanged ? news.description : undefined,
                dataExtraDimensions: dimensionsChanged
                  ? news.dataExtraDimensions
                  : undefined,
              })
              .pipe(inFleetWiseRegion);
          }

          // 3b. Approve a waiting campaign when requested.
          if (
            news.autoApprove === true &&
            observed.status === "WAITING_FOR_APPROVAL"
          ) {
            yield* iotfleetwise
              .updateCampaign({ name, action: "APPROVE" })
              .pipe(inFleetWiseRegion);
          }

          // 3c. Sync tags against OBSERVED cloud tags.
          const arn = observed.arn;
          if (arn !== undefined) {
            yield* syncFleetWiseTags(arn, desiredTags);
          }

          observed = yield* waitUntilSettled(name);
          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Deleting a campaign suspends data collection and removes it
          // from vehicles; deleting a missing campaign is success.
          yield* iotfleetwise
            .deleteCampaign({ name: output.campaignName })
            .pipe(
              inFleetWiseRegion,
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          iotfleetwise.listCampaigns.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((summary) =>
                summary.name !== undefined && summary.arn !== undefined
                  ? [
                      {
                        campaignName: summary.name,
                        campaignArn: summary.arn,
                        status: summary.status ?? "CREATING",
                        signalCatalogArn: summary.signalCatalogArn,
                        targetArn: summary.targetArn,
                      },
                    ]
                  : [],
              ),
            ),
            inFleetWiseRegion,
          ),
      };
    }),
  );
