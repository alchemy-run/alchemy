import * as analytics from "@distilled.cloud/gcp/analyticsadmin_v1beta";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_STREAM_TYPE,
  encodeOwnershipLine,
  findDataStreamByDisplayName,
  getDataStream,
  hasOwnershipMarker,
  ignoreMissing,
  lastSegment,
  listAllProperties,
  listDataStreams,
  MAX_DATA_STREAM_DISPLAY_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parentOf,
  parseOwnership,
  replaceOnIdentity,
  sameText,
  toDisplayName,
  toPropertyName,
  updateMaskOf,
} from "./internal.ts";

export type WebStreamData = {
  /** Domain of the web app being measured, for example `https://example.com`. */
  defaultUri?: string;
};

export type AndroidAppStreamData = {
  /**
   * Android package name. Immutable — changing it replaces the stream.
   * Example: `com.example.app`.
   */
  packageName?: string;
};

export type IosAppStreamData = {
  /**
   * Apple App Store bundle id. Immutable — changing it replaces the
   * stream. Example: `com.example.ios`.
   */
  bundleId?: string;
};

export type PropertiesDataStreamProps = {
  /**
   * Parent property. Full name `properties/{property}` or the numeric
   * property id. Immutable — changing it replaces the stream.
   */
  parent: string;
  /**
   * Resource name `properties/{property}/dataStreams/{stream}` or the
   * stream id. Server-assigned on create. Immutable — changing it
   * replaces the stream.
   */
  dataStreamId?: string;
  /**
   * Stream type. Immutable — changing it replaces the stream.
   * @default "WEB_DATA_STREAM"
   */
  type?: analytics.GoogleAnalyticsAdminV1betaDataStreamTypeEnum | (string & {});
  /**
   * Human-readable display name (max 255 UTF-16 code units including
   * Alchemy's ownership marker). Data streams have no labels field, so
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes. Required for web streams.
   */
  displayName?: string;
  /** Web-stream fields. Must be set when `type` is `WEB_DATA_STREAM`. */
  webStreamData?: WebStreamData;
  /**
   * Android-app fields. Must be set when `type` is
   * `ANDROID_APP_DATA_STREAM`.
   */
  androidAppStreamData?: AndroidAppStreamData;
  /**
   * iOS-app fields. Must be set when `type` is `IOS_APP_DATA_STREAM`.
   */
  iosAppStreamData?: IosAppStreamData;
};

export type PropertiesDataStream = Resource<
  "GCP.Analyticsadmin.PropertiesDataStream",
  PropertiesDataStreamProps,
  {
    /** Full resource name `properties/{property}/dataStreams/{stream}`. */
    name: string;
    /** Stream id (last path segment). */
    dataStreamId: string;
    /** Parent property resource name. */
    parent: string;
    /** Project id used when the stream was reconciled. */
    project: string;
    /** Stream type. */
    type: string | undefined;
    /** User-facing display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Web-stream data, when present. */
    webStreamData:
      | {
          defaultUri: string | undefined;
          measurementId: string | undefined;
          firebaseAppId: string | undefined;
        }
      | undefined;
    /** Android-app stream data, when present. */
    androidAppStreamData:
      | {
          packageName: string | undefined;
          firebaseAppId: string | undefined;
        }
      | undefined;
    /** iOS-app stream data, when present. */
    iosAppStreamData:
      | {
          bundleId: string | undefined;
          firebaseAppId: string | undefined;
        }
      | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Analytics 4 data stream on a property.
 *
 * Data streams have no labels field, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Parent, type, and app identifiers
 * are identity — changing them replaces the stream. Display name and
 * web default URI update in place.
 *
 * ### Creating a Data Stream
 * **Example:** Web stream
 * ```typescript
 * const stream = yield* GCP.Analyticsadmin.PropertiesDataStream("Web", {
 *   parent: property.name,
 *   type: "WEB_DATA_STREAM",
 *   displayName: "www",
 *   webStreamData: { defaultUri: "https://example.com" },
 * });
 * ```
 *
 * **Example:** Generated display name
 * ```typescript
 * const stream = yield* GCP.Analyticsadmin.PropertiesDataStream("Web", {
 *   parent: property.name,
 * });
 * ```
 *
 * ### Updating a Data Stream
 * **Example:** Change the default URI
 * ```typescript
 * const stream = yield* GCP.Analyticsadmin.PropertiesDataStream("Web", {
 *   parent: property.name,
 *   dataStreamId: existing.dataStreamId,
 *   displayName: "www",
 *   webStreamData: { defaultUri: "https://example.com/app" },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Analyticsadmin
 */
export const PropertiesDataStream = Resource<PropertiesDataStream>(
  "GCP.Analyticsadmin.PropertiesDataStream",
);

export class PropertiesDataStreamNotResolved extends Data.TaggedError(
  "GCP.Analyticsadmin.PropertiesDataStreamNotResolved",
)<{
  name: string;
}> {}

const lookupName = (
  parent: string,
  dataStreamId: string | undefined,
  existingName: string | undefined,
) => {
  if (existingName !== undefined && existingName.length > 0) {
    return existingName;
  }
  if (dataStreamId !== undefined && dataStreamId.length > 0) {
    return dataStreamId.includes("/")
      ? dataStreamId
      : `${toPropertyName(parent)}/dataStreams/${dataStreamId}`;
  }
  return "";
};

const webOf = (
  data: analytics.GoogleAnalyticsAdminV1betaDataStreamWebStreamData | undefined,
) => {
  if (data === undefined) return undefined;
  return {
    defaultUri: data.defaultUri,
    measurementId: data.measurementId,
    firebaseAppId: data.firebaseAppId,
  };
};

const androidOf = (
  data:
    | analytics.GoogleAnalyticsAdminV1betaDataStreamAndroidAppStreamData
    | undefined,
) => {
  if (data === undefined) return undefined;
  return {
    packageName: data.packageName,
    firebaseAppId: data.firebaseAppId,
  };
};

const iosOf = (
  data:
    | analytics.GoogleAnalyticsAdminV1betaDataStreamIosAppStreamData
    | undefined,
) => {
  if (data === undefined) return undefined;
  return {
    bundleId: data.bundleId,
    firebaseAppId: data.firebaseAppId,
  };
};

const toAttrs = (
  stream: analytics.GoogleAnalyticsAdminV1betaDataStream,
  project: string,
) => {
  const name = stream.name ?? "";
  return {
    name,
    dataStreamId: lastSegment(name),
    parent: parentOf(name),
    project,
    type: stream.type,
    displayName: parseOwnership(stream.displayName).text,
    webStreamData: webOf(stream.webStreamData),
    androidAppStreamData: androidOf(stream.androidAppStreamData),
    iosAppStreamData: iosOf(stream.iosAppStreamData),
    createTime: stream.createTime,
    updateTime: stream.updateTime,
  };
};

export const PropertiesDataStreamProvider = () =>
  Provider.succeed(PropertiesDataStream, {
    stables: [
      "name",
      "dataStreamId",
      "parent",
      "type",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (
        previousParent !== undefined &&
        toPropertyName(news.parent) !== toPropertyName(previousParent)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousType = olds?.type ?? output?.type;
      const nextType = news.type ?? DEFAULT_STREAM_TYPE;
      if (previousType !== undefined && previousType !== nextType) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousPackage =
        olds?.androidAppStreamData?.packageName ??
        output?.androidAppStreamData?.packageName;
      const nextPackage = news.androidAppStreamData?.packageName;
      if (
        previousPackage !== undefined &&
        nextPackage !== undefined &&
        previousPackage !== nextPackage
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousBundle =
        olds?.iosAppStreamData?.bundleId ?? output?.iosAppStreamData?.bundleId;
      const nextBundle = news.iosAppStreamData?.bundleId;
      if (
        previousBundle !== undefined &&
        nextBundle !== undefined &&
        previousBundle !== nextBundle
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return replaceOnIdentity({
        previousId: olds?.dataStreamId ?? output?.dataStreamId,
        nextId:
          news.dataStreamId !== undefined
            ? lastSegment(news.dataStreamId)
            : undefined,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toPropertyName(olds?.parent ?? output?.parent ?? "");
      const name = lookupName(
        parent,
        olds?.dataStreamId ?? output?.dataStreamId,
        output?.name,
      );
      let existing = yield* getDataStream(name);
      if (existing === undefined && parent.length > 0) {
        const ownership = yield* ownershipLabels(id);
        existing = yield* findDataStreamByDisplayName(
          parent,
          encodeOwnershipLine(
            ownership,
            olds?.displayName ?? output?.displayName,
            MAX_DATA_STREAM_DISPLAY_NAME_LENGTH,
          ),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const properties = yield* listAllProperties();
        const pages = yield* Effect.forEach(
          properties,
          (property) =>
            property.name
              ? listDataStreams(property.name)
              : Effect.succeed(
                  [] as analytics.GoogleAnalyticsAdminV1betaDataStream[],
                ),
          { concurrency: 4 },
        );
        return pages
          .flat()
          .filter((stream) => hasOwnershipMarker(stream.displayName))
          .map((stream) => toAttrs(stream, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toPropertyName(news.parent);
      const ownership = yield* ownershipLabels(id);
      const rawDisplayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const displayName = encodeOwnershipLine(
        ownership,
        rawDisplayName,
        MAX_DATA_STREAM_DISPLAY_NAME_LENGTH,
      );
      const type = news.type ?? output?.type ?? DEFAULT_STREAM_TYPE;
      const name = lookupName(
        parent,
        news.dataStreamId ?? output?.dataStreamId,
        output?.name,
      );
      const webStreamData =
        type === "WEB_DATA_STREAM"
          ? { defaultUri: news.webStreamData?.defaultUri }
          : undefined;
      const androidAppStreamData =
        type === "ANDROID_APP_DATA_STREAM"
          ? { packageName: news.androidAppStreamData?.packageName }
          : undefined;
      const iosAppStreamData =
        type === "IOS_APP_DATA_STREAM"
          ? { bundleId: news.iosAppStreamData?.bundleId }
          : undefined;

      let current = yield* getDataStream(name);
      if (current === undefined) {
        current = yield* findDataStreamByDisplayName(parent, displayName);
      }

      if (current === undefined) {
        const created = yield* analytics
          .createPropertiesDataStreams({
            parent,
            body: {
              type,
              displayName,
              webStreamData,
              androidAppStreamData,
              iosAppStreamData,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findDataStreamByDisplayName(parent, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PropertiesDataStreamNotResolved({
          name: name || displayName,
        });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const uriChanged =
        type === "WEB_DATA_STREAM" &&
        !sameText(
          current.webStreamData?.defaultUri,
          news.webStreamData?.defaultUri,
        );

      const updateMask = updateMaskOf(
        displayChanged ? "display_name" : undefined,
        uriChanged ? "web_stream_data.default_uri" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* analytics.patchPropertiesDataStreams({
          name: currentName,
          updateMask,
          body: {
            displayName,
            webStreamData,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      yield* ignoreMissing(
        analytics.deletePropertiesDataStreams({ name: output.name }),
      );
    }),
  });
