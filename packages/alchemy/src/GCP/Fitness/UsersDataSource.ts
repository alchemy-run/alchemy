import * as fitness from "@distilled.cloud/gcp/fitness_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  applicationOf,
  DEFAULT_APPLICATION_NAME,
  DEFAULT_TYPE,
  DEFAULT_USER,
  dataTypeOf,
  defaultDataType,
  deleteDataSource,
  deviceIdentityOf,
  deviceOf,
  encodeOwnershipLine,
  findOwnedDataSource,
  getDataSource,
  hasOwnershipMarker,
  jsonEqual,
  listOwnedDataSources,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameText,
  toDataStreamName,
  toGeneratedName,
  toUserId,
} from "./internal.ts";

export type UsersDataSourceProps = {
  /**
   * Fitness user id. Only `"me"` is supported by the API.
   * @default "me"
   */
  userId?: string;
  /**
   * Server-generated data stream id. Do not set on create — Fitness
   * derives it from type, data type, project, device, and stream name.
   * Immutable — changing it replaces the data source.
   */
  dataStreamId?: string;
  /**
   * End-user visible name. Data sources have no labels field, so Alchemy
   * stamps ownership into a `[alchemy …]` prefix and strips it from
   * attributes.
   */
  name?: string;
  /**
   * Stream name that distinguishes this source from others of the same
   * type from the same producer. If omitted, a unique name is generated.
   * Immutable — changing it replaces the data source.
   */
  dataStreamName?: string;
  /**
   * Whether this source produces raw or derived data.
   * @default "derived"
   */
  type?: fitness.DataSourceTypeEnum | (string & {});
  /**
   * Schema of the stream. Defaults to `com.google.step_count.delta`.
   * Immutable — changing `dataType.name` replaces the data source.
   */
  dataType?: fitness.DataType;
  /**
   * Application that feeds this stream. REST clients must set `name`.
   * Defaults to `{ name: "Alchemy" }`.
   */
  application?: fitness.Application;
  /**
   * Hardware device that produced the stream. `manufacturer`, `model`,
   * `uid`, and `type` are identity — changing them replaces the source.
   * `version` updates in place.
   */
  device?: fitness.Device;
};

export type UsersDataSource = Resource<
  "GCP.Fitness.UsersDataSource",
  UsersDataSourceProps,
  {
    /** Server-generated data stream id. */
    dataStreamId: string;
    /** Fitness user id (`me`). */
    userId: string;
    /** Project id used when the data source was reconciled. */
    project: string;
    /** User-facing name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** Stream name among sources of the same type. */
    dataStreamName: string | undefined;
    /** Raw or derived. */
    type: string | undefined;
    /** Data type schema. */
    dataType: fitness.DataType | undefined;
    /** Application metadata (`packageName` omitted for REST). */
    application: fitness.Application | undefined;
    /** Device metadata. */
    device: fitness.Device | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Fit user data source.
 *
 * Fitness data sources have no labels field, so Alchemy stamps ownership
 * into `name` for `list` / nuke. `userId`, `type`, `dataType.name`,
 * `dataStreamName`, and device identity (`manufacturer` / `model` /
 * `uid` / `type`) are identity — changing them replaces the source.
 * Display name, application metadata, and `device.version` update in
 * place. Creating data sources as a service account requires a user
 * OAuth token with a Fitness write scope (for example
 * `fitness.activity.write`); use domain-wide delegation for a live
 * lifecycle.
 *
 * ### Creating a Data Source
 * **Example:** Generated stream name
 * ```typescript
 * const source = yield* GCP.Fitness.UsersDataSource("Steps", {});
 * ```
 *
 * **Example:** Named derived step counter
 * ```typescript
 * const source = yield* GCP.Fitness.UsersDataSource("Steps", {
 *   name: "Alchemy Steps",
 *   type: "derived",
 *   dataType: {
 *     name: "com.google.step_count.delta",
 *     field: [{ name: "steps", format: "integer" }],
 *   },
 *   application: { name: "Alchemy", version: "1" },
 * });
 * ```
 *
 * ### Updating a Data Source
 * **Example:** Rename
 * ```typescript
 * const source = yield* GCP.Fitness.UsersDataSource("Steps", {
 *   dataStreamId: existing.dataStreamId,
 *   name: "Alchemy Steps v2",
 *   application: { name: "Alchemy", version: "2" },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Fitness
 */
export const UsersDataSource = Resource<UsersDataSource>(
  "GCP.Fitness.UsersDataSource",
);

export class UsersDataSourceNotResolved extends Data.TaggedError(
  "GCP.Fitness.UsersDataSourceNotResolved",
)<{
  userId: string;
  dataStreamId: string;
}> {}

const toAttrs = (
  source: fitness.DataSource,
  userId: string,
  project: string,
) => ({
  dataStreamId: source.dataStreamId ?? "",
  userId,
  project,
  name: parseOwnership(source.name).text,
  dataStreamName: source.dataStreamName,
  type: source.type,
  dataType: dataTypeOf(source.dataType),
  application: applicationOf(source.application),
  device: deviceOf(source.device),
});

const desiredType = (
  news: UsersDataSourceProps,
  current: fitness.DataSource | undefined,
) => news.type ?? current?.type ?? DEFAULT_TYPE;

const desiredDataType = (
  news: UsersDataSourceProps,
  current: fitness.DataSource | undefined,
) => news.dataType ?? current?.dataType ?? defaultDataType();

const desiredApplication = (
  news: UsersDataSourceProps,
  current: fitness.DataSource | undefined,
): fitness.Application => ({
  name:
    news.application?.name ??
    current?.application?.name ??
    DEFAULT_APPLICATION_NAME,
  version: news.application?.version ?? current?.application?.version,
  detailsUrl: news.application?.detailsUrl ?? current?.application?.detailsUrl,
});

const desiredDevice = (
  news: UsersDataSourceProps,
  current: fitness.DataSource | undefined,
): fitness.Device | undefined => {
  if (news.device === undefined && current?.device === undefined) {
    return undefined;
  }
  return {
    version: news.device?.version ?? current?.device?.version,
    model: news.device?.model ?? current?.device?.model,
    manufacturer: news.device?.manufacturer ?? current?.device?.manufacturer,
    uid: news.device?.uid ?? current?.device?.uid,
    type: news.device?.type ?? current?.device?.type,
  };
};

export const UsersDataSourceProvider = () =>
  Provider.succeed(UsersDataSource, {
    stables: ["dataStreamId", "userId", "project", "type", "dataStreamName"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousUser = olds?.userId ?? output?.userId ?? DEFAULT_USER;
      const nextUser = news.userId ?? DEFAULT_USER;
      if (nextUser !== previousUser) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.dataStreamId ?? output?.dataStreamId;
      if (
        previousId !== undefined &&
        news.dataStreamId !== undefined &&
        news.dataStreamId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousStream = olds?.dataStreamName ?? output?.dataStreamName;
      if (
        previousStream !== undefined &&
        news.dataStreamName !== undefined &&
        news.dataStreamName !== previousStream
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousType = olds?.type ?? output?.type ?? DEFAULT_TYPE;
      const nextType = news.type ?? DEFAULT_TYPE;
      if (nextType !== previousType) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousDataType = olds?.dataType?.name ?? output?.dataType?.name;
      if (
        previousDataType !== undefined &&
        news.dataType?.name !== undefined &&
        news.dataType.name !== previousDataType
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (
        (olds !== undefined || output !== undefined) &&
        news.device !== undefined &&
        !jsonEqual(
          deviceIdentityOf(news.device),
          deviceIdentityOf(olds?.device ?? output?.device),
        )
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = toUserId(olds?.userId, output?.userId);
      const dataStreamId = olds?.dataStreamId ?? output?.dataStreamId ?? "";
      let existing = yield* getDataSource(userId, dataStreamId);
      if (existing === undefined) {
        existing = yield* findOwnedDataSource(
          userId,
          id,
          olds?.dataStreamName ?? output?.dataStreamName,
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, userId, env.project);
      return (yield* ownedByAlchemy(id, existing.name))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwnedDataSources(DEFAULT_USER);
        return items
          .filter((item) => hasOwnershipMarker(item.name))
          .map((item) => toAttrs(item, DEFAULT_USER, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = toUserId(news.userId, output?.userId);
      const labels = yield* ownershipLabels(id);
      const displayName = yield* toGeneratedName(id, news.name, output?.name);
      const name = encodeOwnershipLine(labels, displayName);
      const dataStreamName = yield* toDataStreamName(
        id,
        news.dataStreamName,
        output?.dataStreamName,
      );

      let current = yield* getDataSource(
        userId,
        news.dataStreamId ?? output?.dataStreamId ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedDataSource(userId, id, dataStreamName);
      }

      if (current === undefined) {
        const body: fitness.DataSource = {
          name,
          dataStreamName,
          type: desiredType(news, undefined),
          dataType: desiredDataType(news, undefined),
          application: desiredApplication(news, undefined),
          device: desiredDevice(news, undefined),
        };
        const created = yield* fitness
          .createUsersDataSources({
            userId,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedDataSource(userId, id, dataStreamName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new UsersDataSourceNotResolved({
          userId,
          dataStreamId:
            news.dataStreamId ?? output?.dataStreamId ?? dataStreamName,
        });
      }

      const dataStreamId =
        current.dataStreamId ?? news.dataStreamId ?? output?.dataStreamId ?? "";
      const nextApplication = desiredApplication(news, current);
      const nextDevice = desiredDevice(news, current);
      const nameChanged = !sameText(current.name, name);
      const applicationChanged = !jsonEqual(
        applicationOf(current.application),
        applicationOf(nextApplication),
      );
      const deviceVersionChanged =
        (nextDevice?.version ?? "") !== (current.device?.version ?? "");

      if (nameChanged || applicationChanged || deviceVersionChanged) {
        current = yield* fitness.updateUsersDataSources({
          userId,
          dataSourceId: dataStreamId,
          body: {
            dataStreamId,
            dataStreamName: current.dataStreamName,
            type: current.type,
            dataType: current.dataType,
            name,
            application: nextApplication,
            device: nextDevice,
          },
        });
      }

      return toAttrs(current, userId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteDataSource(
        output.userId || DEFAULT_USER,
        output.dataStreamId,
      );
    }),
  });
