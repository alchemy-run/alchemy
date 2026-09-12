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
  encodeOwnershipLine,
  findSecretByDisplayName,
  getMeasurementProtocolSecret,
  hasOwnershipMarker,
  ignoreMissing,
  lastSegment,
  listAllProperties,
  listDataStreams,
  listMeasurementProtocolSecrets,
  MAX_SECRET_DISPLAY_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parentOf,
  parseOwnership,
  replaceOnIdentity,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./internal.ts";

export type PropertiesDataStreamsMeasurementProtocolSecretProps = {
  /**
   * Parent data stream. Full name
   * `properties/{property}/dataStreams/{stream}`. Immutable — changing
   * it replaces the secret.
   */
  parent: string;
  /**
   * Resource name
   * `properties/{property}/dataStreams/{stream}/measurementProtocolSecrets/{secret}`
   * or the secret id. Server-assigned on create. Immutable — changing
   * it replaces the secret.
   */
  secretId?: string;
  /**
   * Human-readable display name (including Alchemy's ownership marker).
   * Measurement protocol secrets have no labels field, so ownership is
   * stored in a `[alchemy …]` prefix and stripped from attributes.
   */
  displayName?: string;
};

export type PropertiesDataStreamsMeasurementProtocolSecret = Resource<
  "GCP.Analyticsadmin.PropertiesDataStreamsMeasurementProtocolSecret",
  PropertiesDataStreamsMeasurementProtocolSecretProps,
  {
    /** Full resource name. */
    name: string;
    /** Secret id (last path segment). */
    secretId: string;
    /** Parent data stream resource name. */
    parent: string;
    /** Project id used when the secret was reconciled. */
    project: string;
    /** User-facing display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Secret value passed as `api_secret` to Measurement Protocol. */
    secretValue: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Measurement Protocol secret on a Google Analytics 4 data stream.
 *
 * Secrets have no labels field, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Parent stream and id are identity —
 * changing either replaces the secret. Display name updates in place.
 *
 * ### Creating a Secret
 * **Example:** Generated display name
 * ```typescript
 * const secret = yield* GCP.Analyticsadmin.PropertiesDataStreamsMeasurementProtocolSecret(
 *   "Ingest",
 *   { parent: stream.name },
 * );
 * ```
 *
 * **Example:** Explicit display name
 * ```typescript
 * const secret = yield* GCP.Analyticsadmin.PropertiesDataStreamsMeasurementProtocolSecret(
 *   "Ingest",
 *   {
 *     parent: stream.name,
 *     displayName: "server ingest",
 *   },
 * );
 * ```
 *
 * ### Updating a Secret
 * **Example:** Rename
 * ```typescript
 * const secret = yield* GCP.Analyticsadmin.PropertiesDataStreamsMeasurementProtocolSecret(
 *   "Ingest",
 *   {
 *     parent: stream.name,
 *     secretId: existing.secretId,
 *     displayName: "server ingest 2026",
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Analyticsadmin
 */
export const PropertiesDataStreamsMeasurementProtocolSecret =
  Resource<PropertiesDataStreamsMeasurementProtocolSecret>(
    "GCP.Analyticsadmin.PropertiesDataStreamsMeasurementProtocolSecret",
  );

export class PropertiesDataStreamsMeasurementProtocolSecretNotResolved extends Data.TaggedError(
  "GCP.Analyticsadmin.PropertiesDataStreamsMeasurementProtocolSecretNotResolved",
)<{
  name: string;
}> {}

const lookupName = (
  parent: string,
  secretId: string | undefined,
  existingName: string | undefined,
) => {
  if (existingName !== undefined && existingName.length > 0) {
    return existingName;
  }
  if (secretId !== undefined && secretId.length > 0) {
    return secretId.includes("/")
      ? secretId
      : `${parent}/measurementProtocolSecrets/${secretId}`;
  }
  return "";
};

const toAttrs = (
  secret: analytics.GoogleAnalyticsAdminV1betaMeasurementProtocolSecret,
  project: string,
) => {
  const name = secret.name ?? "";
  return {
    name,
    secretId: lastSegment(name),
    parent: parentOf(name),
    project,
    displayName: parseOwnership(secret.displayName).text,
    secretValue: secret.secretValue,
  };
};

export const PropertiesDataStreamsMeasurementProtocolSecretProvider = () =>
  Provider.succeed(PropertiesDataStreamsMeasurementProtocolSecret, {
    stables: ["name", "secretId", "parent", "project", "secretValue"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (previousParent !== undefined && news.parent !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return replaceOnIdentity({
        previousId: olds?.secretId ?? output?.secretId,
        nextId:
          news.secretId !== undefined ? lastSegment(news.secretId) : undefined,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = olds?.parent ?? output?.parent ?? "";
      const name = lookupName(
        parent,
        olds?.secretId ?? output?.secretId,
        output?.name,
      );
      let existing = yield* getMeasurementProtocolSecret(name);
      if (existing === undefined && parent.length > 0) {
        const ownership = yield* ownershipLabels(id);
        existing = yield* findSecretByDisplayName(
          parent,
          encodeOwnershipLine(
            ownership,
            olds?.displayName ?? output?.displayName,
            MAX_SECRET_DISPLAY_NAME_LENGTH,
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
        const streams = (yield* Effect.forEach(
          properties,
          (property) =>
            property.name
              ? listDataStreams(property.name)
              : Effect.succeed(
                  [] as analytics.GoogleAnalyticsAdminV1betaDataStream[],
                ),
          { concurrency: 4 },
        )).flat();
        const pages = yield* Effect.forEach(
          streams,
          (stream) =>
            stream.name
              ? listMeasurementProtocolSecrets(stream.name)
              : Effect.succeed(
                  [] as analytics.GoogleAnalyticsAdminV1betaMeasurementProtocolSecret[],
                ),
          { concurrency: 4 },
        );
        return pages
          .flat()
          .filter((secret) => hasOwnershipMarker(secret.displayName))
          .map((secret) => toAttrs(secret, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = news.parent;
      const ownership = yield* ownershipLabels(id);
      const rawDisplayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const displayName = encodeOwnershipLine(
        ownership,
        rawDisplayName,
        MAX_SECRET_DISPLAY_NAME_LENGTH,
      );
      const name = lookupName(
        parent,
        news.secretId ?? output?.secretId,
        output?.name,
      );

      let current = yield* getMeasurementProtocolSecret(name);
      if (current === undefined) {
        current = yield* findSecretByDisplayName(parent, displayName);
      }

      if (current === undefined) {
        const created = yield* analytics
          .createPropertiesDataStreamsMeasurementProtocolSecrets({
            parent,
            body: { displayName },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findSecretByDisplayName(parent, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PropertiesDataStreamsMeasurementProtocolSecretNotResolved(
          { name: name || displayName },
        );
      }

      const currentName = current.name ?? name;
      if (!sameText(current.displayName, displayName)) {
        current =
          yield* analytics.patchPropertiesDataStreamsMeasurementProtocolSecrets(
            {
              name: currentName,
              updateMask: updateMaskOf("display_name"),
              body: { displayName },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      yield* ignoreMissing(
        analytics.deletePropertiesDataStreamsMeasurementProtocolSecrets({
          name: output.name,
        }),
      );
    }),
  });
