import { createHash } from "node:crypto";
import * as pipes from "@distilled.cloud/clickhouse-cloud/click_pipes";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import { Resource } from "alchemy/Resource";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { FeatureUnavailable, ResultMissing, requireResult } from "../Errors.ts";
import { isOwnedName, resolveName } from "../internal/Names.ts";
import { pollUntil } from "../internal/Wait.ts";
import type { Providers } from "../Providers.ts";

/** The source kinds a pipe reads from: exactly one member of `source` is set. */
export type ClickPipeSourceKind = Exclude<keyof pipes.ClickPipePostSource, "validateSamples">;

export interface ClickPipeProps {
  /** ID of the destination service, e.g. a `ClickHouseCloud.Service.Service`'s `serviceId`. Changing it replaces the pipe. */
  serviceId: string;
  /**
   * Pipe name. If omitted, a unique name is generated from the stack, stage
   * and logical ID. Changing it renames the pipe in place.
   */
  name?: string;
  /**
   * Where the data comes from: exactly one of `kafka`, `objectStorage`,
   * `kinesis`, `pubsub`, `postgres`, `mysql`, `bigquery` or `mongodb`.
   * Credentials are write-only; the fields the API can't update (a Kafka
   * topic, an object storage URL, the format, …) replace the pipe.
   */
  source: pipes.ClickPipePostSource;
  /**
   * Where the data goes. Only `columns` updates in place; the database,
   * table, table definition and roles replace the pipe.
   */
  destination: pipes.ClickPipeMutateDestination;
  /** Source field to destination column mappings; every destination column must be mapped. */
  fieldMappings?: pipes.ClickPipeFieldMapping[];
  /** Replicas and resources (Kafka, Kinesis and object storage pipes). Omit to leave them alone. */
  scaling?: pipes.ClickPipeScaling;
  /** Advanced ingestion settings. Omit to leave them alone. */
  settings?: pipes.ClickPipeSettings;
  /**
   * `running` ingests; `stopped` pauses ingestion. A one-shot object
   * storage pipe that `Completed` counts as running.
   * @default "running"
   */
  state?: "running" | "stopped";
}

export interface ClickPipeAttributes {
  /** ClickPipe ID. */
  clickPipeId: string;
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** Pipe name. */
  name: string;
  /** `Running`, `Completed`, `Stopped`, `Snapshot`, `Failed`, …. */
  state: string | undefined;
  /** The source as ClickHouse reports it (credentials are never returned). */
  source: pipes.ClickPipeSource | undefined;
  /** The destination. */
  destination: pipes.ClickPipeDestination | undefined;
  /** Field mappings. */
  fieldMappings: pipes.ClickPipeFieldMapping[];
  /** Scaling. */
  scaling: pipes.ClickPipeScaling | undefined;
  /** Settings. */
  settings: pipes.ClickPipeSettings | undefined;
  /** SHA-256 of the source last applied, credentials included, to detect a change. */
  sourceDigest: Redacted.Redacted<string>;
  /** When the pipe was created. */
  createdAt: string | undefined;
}

export type ClickPipe = Resource<
  "ClickHouseCloud.ClickPipes.ClickPipe",
  ClickPipeProps,
  ClickPipeAttributes,
  never,
  Providers
>;

/**
 * A ClickPipe: managed ingestion into a service's table from Kafka (and
 * Redpanda, MSK, Confluent, Event Hubs, …), object storage (S3, GCS, R2,
 * Azure Blob, …), Kinesis, Pub/Sub, or change data capture from Postgres,
 * MySQL, MongoDB and BigQuery.
 *
 * Deploy waits until the pipe ingests (`Running`), finished a one-shot load
 * (`Completed`), stopped (`state: "stopped"`), or started its initial
 * snapshot (`Snapshot`, for database pipes: the snapshot itself can take
 * hours). A pipe that fails fails the deploy with its state. The name,
 * destination columns, field mappings, scaling, settings and the source's
 * mutable fields (credentials, paths, table mappings) update in place;
 * everything else replaces the pipe. Credentials are write-only: a change
 * is detected from the digest of the last source applied. ClickPipes have
 * no tags, so a generated name is the ownership marker.
 * @see https://clickhouse.com/docs/integrations/clickpipes
 *
 * ### Loading Files
 * **Example:** A one-shot load of a public CSV file into a new table
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 * yield* ClickHouseCloud.ClickPipes.ClickPipe("Stations", {
 *   serviceId: analytics.serviceId,
 *   source: {
 *     objectStorage: {
 *       type: "s3",
 *       format: "CSVWithNames",
 *       url: "https://datasets-documentation.s3.eu-west-3.amazonaws.com/1brc/stations.csv",
 *       isContinuous: false,
 *     },
 *   },
 *   destination: {
 *     database: "default",
 *     table: "stations",
 *     managedTable: true,
 *     tableDefinition: { engine: { type: "MergeTree" }, sortingKey: ["station"] },
 *     columns: [
 *       { name: "station", type: "String" },
 *       { name: "avg", type: "Float64" },
 *     ],
 *   },
 *   fieldMappings: [
 *     { sourceField: "station", destinationField: "station" },
 *     { sourceField: "avg", destinationField: "avg" },
 *   ],
 * });
 * ```
 *
 * ### Streaming from Kafka
 * **Example:** A topic with SASL credentials kept in a secret
 * ```typescript
 * yield* ClickHouseCloud.ClickPipes.ClickPipe("Events", {
 *   serviceId: analytics.serviceId,
 *   source: {
 *     kafka: {
 *       type: "confluent",
 *       format: "JSONEachRow",
 *       brokers: "pkc-123.us-east-1.aws.confluent.cloud:9092",
 *       topics: "events",
 *       authentication: "PLAIN",
 *       credentials: { username: "<key>", password: yield* Config.string("KAFKA_SECRET") },
 *     },
 *   },
 *   destination: {
 *     database: "default",
 *     table: "events",
 *     managedTable: true,
 *     tableDefinition: { engine: { type: "MergeTree" } },
 *     columns: [{ name: "payload", type: "String" }],
 *   },
 *   fieldMappings: [{ sourceField: "payload", destinationField: "payload" }],
 *   scaling: { replicas: 2 },
 * });
 * ```
 *
 * :::caution
 * Replacing a pipe (a new topic, URL, format or destination table) starts
 * ingestion again from the source's configured offset; a managed table is
 * recreated.
 * :::
 *
 * @resource
 * @product ClickPipes
 */
export const ClickPipe = Resource<ClickPipe>("ClickHouseCloud.ClickPipes.ClickPipe");

/** Source fields each kind can change without a new pipe. */
const PATCHABLE: Record<ClickPipeSourceKind, readonly string[]> = {
  kafka: ["authentication", "iamRole", "caCertificate", "reversePrivateEndpointIds", "credentials"],
  objectStorage: [
    "skipInitialLoad",
    "startAfter",
    "authentication",
    "iamRole",
    "connectionString",
    "path",
    "azureContainerName",
    "accessKey",
    "serviceAccountKey",
  ],
  kinesis: ["authentication", "iamRole", "accessKey"],
  pubsub: ["authentication", "ackDeadline", "serviceAccountKey"],
  postgres: [
    "credentials",
    "host",
    "port",
    "database",
    "tlsHost",
    "caCertificate",
    "disableTls",
    "skipCertVerification",
    "settings",
    "tableMappings",
  ],
  mysql: [
    "credentials",
    "host",
    "port",
    "authentication",
    "iamRole",
    "tlsHost",
    "caCertificate",
    "disableTls",
    "skipCertVerification",
    "serverId",
    "settings",
    "tableMappings",
  ],
  mongodb: [
    "credentials",
    "uri",
    "readPreference",
    "tlsHost",
    "disableTls",
    "skipCertVerification",
    "caCertificate",
    "settings",
    "tableMappings",
  ],
  bigquery: [],
};

const KINDS = Object.keys(PATCHABLE) as ClickPipeSourceKind[];

const kindOf = (source: pipes.ClickPipePostSource): ClickPipeSourceKind | undefined =>
  KINDS.find((kind) => source[kind] !== undefined);

/** Change data capture sources: they can't be created stopped. */
const DATABASE_KINDS: readonly ClickPipeSourceKind[] = ["postgres", "mysql", "mongodb", "bigquery"];

const fieldsOf = (source: pipes.ClickPipePostSource, kind: ClickPipeSourceKind) =>
  (source[kind] ?? {}) as Record<string, unknown>;

/** A stable digest of a value, secrets included (`Redacted` values are unwrapped). */
const digest = (value: unknown) =>
  Redacted.make(
    createHash("sha256")
      .update(
        JSON.stringify(value, (_, v: unknown) => (Redacted.isRedacted(v) ? Redacted.value(v) : v)),
      )
      .digest("hex"),
  );

const sameDigest = (a: Redacted.Redacted<string> | undefined, b: Redacted.Redacted<string>) =>
  a !== undefined && Redacted.value(a) === Redacted.value(b);

/** Whether a change of source from `olds` to `news` needs a new pipe. */
const sourceNeedsReplace = (olds: pipes.ClickPipePostSource, news: pipes.ClickPipePostSource) => {
  const kind = kindOf(news);
  if (kind === undefined || kind !== kindOf(olds)) return true;
  const before = fieldsOf(olds, kind);
  const after = fieldsOf(news, kind);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].some(
    (key) => !PATCHABLE[kind].includes(key) && !deepEqual(before[key], after[key]),
  );
};

/** The source patch: the mutable fields that changed, table mappings as a delta. */
const sourcePatch = (
  kind: ClickPipeSourceKind,
  olds: pipes.ClickPipePostSource,
  news: pipes.ClickPipePostSource,
): pipes.ClickPipePatchSource | undefined => {
  const before = fieldsOf(olds, kind);
  const after = fieldsOf(news, kind);
  const patch: Record<string, unknown> = {};
  for (const key of PATCHABLE[kind]) {
    if (deepEqual(before[key], after[key])) continue;
    if (key === "tableMappings") {
      const was = (before[key] ?? []) as unknown[];
      const now = (after[key] ?? []) as unknown[];
      const added = now.filter((m) => !was.some((w) => deepEqual(w, m)));
      const removed = was.filter((w) => !now.some((m) => deepEqual(w, m)));
      if (added.length > 0) patch.tableMappingsToAdd = added;
      if (removed.length > 0) patch.tableMappingsToRemove = removed;
    } else {
      patch[key] = after[key];
    }
  }
  if (Object.keys(patch).length === 0) return undefined;
  return { [kind]: patch } as pipes.ClickPipePatchSource;
};

const DESTINATION_IMMUTABLE = [
  "database",
  "table",
  "managedTable",
  "tableDefinition",
  "roles",
] as const;

const toAttributes = (
  organizationId: string,
  serviceId: string,
  pipe: pipes.ClickPipe,
  sourceDigest: Redacted.Redacted<string>,
): ClickPipeAttributes => ({
  clickPipeId: pipe.id ?? "",
  serviceId,
  organizationId,
  name: pipe.name ?? "",
  state: pipe.state,
  source: pipe.source,
  destination: pipe.destination,
  fieldMappings: pipe.fieldMappings ?? [],
  scaling: pipe.scaling,
  settings: pipe.settings,
  sourceDigest,
  createdAt: pipe.createdAt,
});

const getPipe = (organizationId: string, serviceId: string, clickPipeId: string) =>
  pipes.getClickPipe({ organizationId, serviceId, clickPipeId }).pipe(
    Effect.flatMap(requireResult("getClickPipe")),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const findByName = (organizationId: string, serviceId: string, name: string) =>
  pipes.listClickPipes.items({ organizationId, serviceId }).pipe(
    Stream.filter((p) => p.name === name),
    Stream.runHead,
    Effect.map((found) => (found._tag === "Some" ? found.value : undefined)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const RUNNING: Partial<Record<string, true>> = {
  Running: true,
  Completed: true,
  Snapshot: true,
  Degraded: true,
};
const STOPPED: Partial<Record<string, true>> = { Stopped: true, Paused: true };
const FAILED: Partial<Record<string, true>> = { Failed: true, InternalError: true };

const waitState = (
  organizationId: string,
  serviceId: string,
  clickPipeId: string,
  want: "running" | "stopped" | "settled",
  session: ScopedPlanStatusSession,
) =>
  pollUntil({
    kind: "ClickPipe",
    id: clickPipeId,
    waitingFor: want,
    read: getPipe(organizationId, serviceId, clickPipeId),
    state: (p) => p?.state,
    done: (p): p is pipes.ClickPipe =>
      p !== undefined &&
      (want === "running"
        ? RUNNING[p.state ?? ""] === true
        : want === "stopped"
          ? STOPPED[p.state ?? ""] === true
          : RUNNING[p.state ?? ""] === true || STOPPED[p.state ?? ""] === true),
    failed: (p) =>
      p === undefined ? "deleted while waiting" : FAILED[p.state ?? ""] ? p.state : undefined,
    session,
    budget: Duration.minutes(30),
  });

export const ClickPipeProvider = () =>
  Provider.effect(
    ClickPipe,
    Effect.succeed({
      stables: ["clickPipeId", "serviceId", "organizationId", "createdAt"],
      nuke: { dependsOn: ["ClickHouseCloud.Service.Service"] },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (
          news.serviceId !== olds.serviceId ||
          sourceNeedsReplace(olds.source, news.source) ||
          DESTINATION_IMMUTABLE.some(
            (key) => !deepEqual(news.destination[key], olds.destination[key]),
          )
        ) {
          // Delete first: the new pipe usually keeps the old one's name, so
          // the two could be told apart only by state.
          return { action: "replace", deleteFirst: true } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ id, olds, output, previous }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const serviceId = output?.serviceId ?? olds.serviceId;
        const name = yield* resolveName(id, olds?.name, output?.name);
        const found = output?.clickPipeId
          ? yield* getPipe(organizationId, serviceId, output.clickPipeId)
          : yield* findByName(organizationId, serviceId, name);
        if (found === undefined) return undefined;
        const attrs = toAttributes(
          organizationId,
          serviceId,
          found,
          output?.sourceDigest ?? digest(olds.source),
        );
        return (yield* isOwnedName(
          id,
          attrs.name,
          output !== undefined || attrs.clickPipeId === previous?.clickPipeId,
        ))
          ? attrs
          : Unowned(attrs);
      }),
      reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId } = news;
        const name = yield* resolveName(id, news.name, output?.name);
        const sourceDigest = digest(news.source);
        const kind = kindOf(news.source);
        if (kind === undefined) {
          return yield* new FeatureUnavailable({
            feature: "ClickPipe",
            reason: "`source` needs exactly one source kind",
          });
        }
        const wantStopped = news.state === "stopped";

        // Observe
        const found = output?.clickPipeId
          ? yield* getPipe(organizationId, serviceId, output.clickPipeId)
          : yield* findByName(organizationId, serviceId, name);

        // Ensure, then wait until the pipe settles.
        let observed: pipes.ClickPipe;
        if (found?.id === undefined) {
          yield* session.note(`Creating ClickPipe "${name}"...`);
          const isDatabase = DATABASE_KINDS.includes(kind);
          const created = yield* pipes
            .createClickPipe({
              organizationId,
              serviceId,
              name,
              source: news.source,
              destination: news.destination,
              fieldMappings: news.fieldMappings,
              scaling: news.scaling,
              settings: news.settings,
              ...(wantStopped && !isDatabase ? { startPaused: true } : {}),
            })
            .pipe(Effect.flatMap(requireResult("createClickPipe")));
          if (created.id === undefined) {
            return yield* new ResultMissing({ operation: "createClickPipe (id)" });
          }
          observed = yield* waitState(
            organizationId,
            serviceId,
            created.id,
            wantStopped ? "stopped" : "running",
            session,
          );
        } else if (!RUNNING[found.state ?? ""] && !STOPPED[found.state ?? ""]) {
          observed = yield* waitState(organizationId, serviceId, found.id, "settled", session);
        } else {
          observed = found;
        }
        const clickPipeId = observed.id ?? found?.id ?? "";

        // Sync: name, columns, mappings and the source's mutable fields; the
        // source baseline is the last applied props (credentials are write-only).
        const patchSource =
          olds !== undefined && !sameDigest(output?.sourceDigest, sourceDigest)
            ? sourcePatch(kind, olds.source, news.source)
            : undefined;
        const patch: Omit<
          pipes.UpdateClickPipeRequest,
          "organizationId" | "serviceId" | "clickPipeId"
        > = {
          ...(observed.name !== name ? { name } : {}),
          ...(patchSource !== undefined ? { source: patchSource } : {}),
          ...(news.destination.columns !== undefined &&
          !deepEqual(news.destination.columns, observed.destination?.columns)
            ? { destination: { columns: news.destination.columns } }
            : {}),
          ...(news.fieldMappings !== undefined &&
          !deepEqual(news.fieldMappings, observed.fieldMappings ?? [])
            ? { fieldMappings: news.fieldMappings }
            : {}),
        };
        if (Object.keys(patch).length > 0) {
          yield* pipes.updateClickPipe({ organizationId, serviceId, clickPipeId, ...patch });
          observed = yield* waitState(organizationId, serviceId, clickPipeId, "settled", session);
        }
        if (news.settings !== undefined) {
          const current = yield* pipes
            .getClickPipeSettings({ organizationId, serviceId, clickPipeId })
            .pipe(Effect.flatMap(requireResult("getClickPipeSettings")));
          const changed = Object.entries(news.settings).some(
            ([key, value]) =>
              value !== undefined && (current as Record<string, unknown>)[key] !== value,
          );
          if (changed) {
            yield* pipes.updateClickPipeSettings({
              organizationId,
              serviceId,
              clickPipeId,
              ...(Object.fromEntries(
                Object.entries({ ...current, ...news.settings }).filter(
                  ([, v]) => v !== null && v !== undefined,
                ),
              ) as Omit<
                pipes.UpdateClickPipeSettingsRequest,
                "organizationId" | "serviceId" | "clickPipeId"
              >),
            });
          }
        }
        if (news.scaling !== undefined) {
          const observedScaling = (observed.scaling ?? {}) as Record<string, unknown>;
          const changed = Object.entries(news.scaling).some(
            ([key, value]) => value !== undefined && observedScaling[key] !== value,
          );
          if (changed) {
            yield* pipes.updateClickPipeScaling({
              organizationId,
              serviceId,
              clickPipeId,
              ...news.scaling,
            });
            observed = yield* waitState(organizationId, serviceId, clickPipeId, "settled", session);
          }
        }

        // Desired state last.
        if (wantStopped && !STOPPED[observed.state ?? ""]) {
          yield* pipes.updateClickPipeState({
            organizationId,
            serviceId,
            clickPipeId,
            command: "stop",
          });
          observed = yield* waitState(organizationId, serviceId, clickPipeId, "stopped", session);
        } else if (!wantStopped && STOPPED[observed.state ?? ""]) {
          yield* pipes.updateClickPipeState({
            organizationId,
            serviceId,
            clickPipeId,
            command: "start",
          });
          observed = yield* waitState(organizationId, serviceId, clickPipeId, "running", session);
        }

        const final = (yield* getPipe(organizationId, serviceId, clickPipeId)) ?? observed;
        return toAttributes(organizationId, serviceId, final, sourceDigest);
      }),
      delete: Effect.fn(function* ({ output, session }) {
        const { organizationId, serviceId, clickPipeId } = output;
        yield* pipes
          .deleteClickPipe({ organizationId, serviceId, clickPipeId })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        yield* pollUntil({
          kind: "ClickPipe",
          id: clickPipeId,
          waitingFor: "deleted",
          read: getPipe(organizationId, serviceId, clickPipeId),
          state: (p) => p?.state,
          done: (p): p is undefined => p === undefined,
          session,
          budget: Duration.minutes(15),
        });
      }),
    }),
  );
