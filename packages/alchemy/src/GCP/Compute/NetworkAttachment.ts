import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitRegionOperations } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_REGION = "us-central1";
const DEFAULT_CONNECTION_PREFERENCE = "ACCEPT_AUTOMATIC";
const MAX_NAME_LENGTH = 63;

export type NetworkAttachmentConnectionPreference =
  | compute.NetworkAttachmentConnectionPreferenceEnum
  | (string & {});
export type NetworkAttachmentConnectedEndpoint =
  compute.NetworkAttachmentConnectedEndpoint;

export type NetworkAttachmentProps = {
  /**
   * Attachment name (RFC1035, 1-63 characters). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the attachment.
   */
  networkAttachmentName?: string;
  /**
   * Region the attachment lives in. Immutable — changing it replaces the
   * attachment. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default "us-central1"
   */
  region?: string;
  /**
   * Subnet URLs or names the consumer provides for producer endpoints.
   * All subnets must be in the same VPC. Required. Updated in place via
   * `patch`.
   */
  subnetworks: string[];
  /**
   * How producer connections are admitted. `ACCEPT_AUTOMATIC` always
   * accepts; `ACCEPT_MANUAL` uses the accept and reject lists.
   * @default "ACCEPT_AUTOMATIC"
   */
  connectionPreference?: NetworkAttachmentConnectionPreference;
  /**
   * Optional description. Compute network attachments have no labels
   * field, so Alchemy ownership (`alchemy-stack` / `alchemy-stage` /
   * `alchemy-id`) is stored in a `[alchemy …]` prefix for `list` / nuke.
   * Updated in place via `patch`.
   */
  description?: string;
  /**
   * Producer projects allowed to connect (id or number). Used with
   * `ACCEPT_MANUAL`. Updated in place via `patch`.
   */
  producerAcceptLists?: string[];
  /**
   * Producer projects that must not connect. Updated in place via
   * `patch`.
   */
  producerRejectLists?: string[];
};

export type NetworkAttachment = Resource<
  "GCP.Compute.NetworkAttachment",
  NetworkAttachmentProps,
  {
    /** Attachment name. */
    networkAttachmentName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Parent VPC network URL. */
    network: string | undefined;
    /** Consumer subnet URLs. */
    subnetworks: ReadonlyArray<string>;
    /** Connection preference. */
    connectionPreference: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Accepted producer projects. */
    producerAcceptLists: ReadonlyArray<string>;
    /** Rejected producer projects. */
    producerRejectLists: ReadonlyArray<string>;
    /** Connected producer endpoints. */
    connectionEndpoints: ReadonlyArray<NetworkAttachmentConnectedEndpoint>;
    /** Optimistic-locking fingerprint. */
    fingerprint: string | undefined;
    /** Server-assigned numeric id. */
    networkAttachmentId: string | undefined;
    /** Resource self-link. */
    selfLink: string | undefined;
    /** Self-link including the numeric id. */
    selfLinkWithId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine Private Service Connect network attachment.
 *
 * A network attachment lets a producer VPC initiate connections into a
 * consumer VPC through a PSC interface. It lists consumer subnets and
 * admits producers either automatically or via accept/reject lists.
 * Compute NetworkAttachment has no labels field — Alchemy ownership is
 * stored in the description so nuke can find leaked attachments.
 *
 * ### Creating a Network Attachment
 * **Example:** Generated name, automatic accept
 * ```typescript
 * const attachment = yield* GCP.Compute.NetworkAttachment("Consumer", {
 *   region: "us-central1",
 *   subnetworks: [subnet.selfLink],
 *   connectionPreference: "ACCEPT_AUTOMATIC",
 * });
 * ```
 *
 * **Example:** Manual admission
 * ```typescript
 * const attachment = yield* GCP.Compute.NetworkAttachment("Consumer", {
 *   networkAttachmentName: "app-na",
 *   subnetworks: [subnet.selfLink],
 *   connectionPreference: "ACCEPT_MANUAL",
 *   producerAcceptLists: ["my-producer-project"],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Compute
 */
export const NetworkAttachment = Resource<NetworkAttachment>(
  "GCP.Compute.NetworkAttachment",
);

export class NetworkAttachmentNotResolved extends Data.TaggedError(
  "GCP.Compute.NetworkAttachmentNotResolved",
)<{
  networkAttachmentName: string;
  region: string;
}> {}

export class NetworkAttachmentOperationFailed extends Data.TaggedError(
  "GCP.Compute.NetworkAttachmentOperationFailed",
)<{
  networkAttachmentName: string;
  operation: string;
  message: string;
}> {}

export class NetworkAttachmentStillExists extends Data.TaggedError(
  "GCP.Compute.NetworkAttachmentStillExists",
)<{
  networkAttachmentName: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined) =>
  lastSegment(region ?? DEFAULT_REGION).toLowerCase();

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) next = `n${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "attachment";
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) labels[part.slice(0, eq)] = part.slice(eq + 1);
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const preferenceOf = (value: string | undefined) =>
  value && value.length > 0 ? value : DEFAULT_CONNECTION_PREFERENCE;

const toSubnetworkUrl = (project: string, region: string, value: string) => {
  if (value.includes("/")) return value;
  return `projects/${project}/regions/${region}/subnetworks/${value}`;
};

const refsKey = (values: ReadonlyArray<string> | undefined) =>
  [...(values ?? [])]
    .map((value) => lastSegment(value))
    .filter((value) => value.length > 0)
    .sort()
    .join(",");

const toAttrs = (
  attachment: compute.NetworkAttachment,
  project: string,
): NetworkAttachment["Attributes"] => {
  const parsed = parseDescription(attachment.description);
  return {
    networkAttachmentName: attachment.name ?? "",
    project,
    region: normalizeRegion(attachment.region),
    network: attachment.network,
    subnetworks: attachment.subnetworks ?? [],
    connectionPreference: attachment.connectionPreference,
    description: parsed.description,
    producerAcceptLists: attachment.producerAcceptLists ?? [],
    producerRejectLists: attachment.producerRejectLists ?? [],
    connectionEndpoints: attachment.connectionEndpoints ?? [],
    fingerprint: attachment.fingerprint,
    networkAttachmentId: attachment.id,
    selfLink: attachment.selfLink,
    selfLinkWithId: attachment.selfLinkWithId,
    creationTimestamp: attachment.creationTimestamp,
    kind: attachment.kind,
  };
};

const operationMessage = (operation: compute.Operation) =>
  (operation.error?.errors ?? [])
    .map((error) => error.message ?? error.code ?? "")
    .filter((part) => part.length > 0)
    .join("; ") ||
  operation.httpErrorMessage ||
  operation.statusMessage ||
  "Compute operation failed";

const operationText = (operation: compute.Operation) =>
  operationMessage(operation).toLowerCase();

const failIfErrored = (
  networkAttachmentName: string,
  operation: compute.Operation,
  options?: { ignoreAlreadyExists?: boolean; ignoreNotFound?: boolean },
) => {
  const text = operationText(operation);
  if (
    options?.ignoreAlreadyExists === true &&
    (text.includes("already exists") || text.includes("already_exists"))
  ) {
    return Effect.void;
  }
  if (
    options?.ignoreNotFound === true &&
    (text.includes("not found") || text.includes("not_found"))
  ) {
    return Effect.void;
  }
  const errors = operation.error?.errors ?? [];
  if (
    errors.length > 0 ||
    (operation.httpErrorStatusCode !== undefined &&
      operation.httpErrorStatusCode >= 400)
  ) {
    return Effect.fail(
      new NetworkAttachmentOperationFailed({
        networkAttachmentName,
        operation: operation.name ?? "",
        message: operationMessage(operation),
      }),
    );
  }
  return Effect.void;
};

const getByName = (
  project: string,
  region: string,
  networkAttachment: string,
) =>
  compute
    .getNetworkAttachments({ project, region, networkAttachment })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitForOperation = (
  project: string,
  region: string,
  operation: compute.Operation,
  networkAttachmentName: string,
  options?: { ignoreAlreadyExists?: boolean; ignoreNotFound?: boolean },
) =>
  Effect.gen(function* () {
    const operationName = lastSegment(operation.name);
    let current = operation;
    if (current.status !== "DONE" && operationName.length > 0) {
      current = yield* waitRegionOperations({
        project,
        region,
        operation: operationName,
      }).pipe(
        Effect.retry({
          while: (error) => error._tag === "NotFound",
          times: 5,
          schedule: Schedule.exponential("250 millis"),
        }),
      );
    }
    if (current.status !== "DONE") {
      return yield* new NetworkAttachmentOperationFailed({
        networkAttachmentName,
        operation: operation.name ?? "",
        message: `Timed out waiting for operation (status=${current.status})`,
      });
    }
    yield* failIfErrored(networkAttachmentName, current, options);
    return current;
  });

const awaitResource = (
  project: string,
  region: string,
  networkAttachmentName: string,
) =>
  getByName(project, region, networkAttachmentName).pipe(
    Effect.flatMap((attachment) =>
      attachment !== undefined
        ? Effect.succeed(attachment)
        : Effect.fail(
            new NetworkAttachmentNotResolved({
              networkAttachmentName,
              region,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.NetworkAttachmentNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (
  project: string,
  region: string,
  networkAttachmentName: string,
) =>
  getByName(project, region, networkAttachmentName).pipe(
    Effect.flatMap((attachment) =>
      attachment === undefined
        ? Effect.void
        : Effect.fail(
            new NetworkAttachmentStillExists({ networkAttachmentName }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.NetworkAttachmentStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.catchTag(
      "GCP.Compute.NetworkAttachmentStillExists",
      () => Effect.void,
    ),
  );

const runOp = <E extends { readonly _tag: string }, R>(
  project: string,
  region: string,
  networkAttachmentName: string,
  start: Effect.Effect<compute.Operation, E, R>,
  options?: { ignoreAlreadyExists?: boolean; ignoreNotFound?: boolean },
) =>
  start.pipe(
    Effect.flatMap((operation) =>
      waitForOperation(
        project,
        region,
        operation,
        networkAttachmentName,
        options,
      ),
    ),
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 5,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const NetworkAttachmentProvider = () =>
  Provider.succeed(NetworkAttachment, {
    stables: [
      "networkAttachmentName",
      "project",
      "region",
      "networkAttachmentId",
      "selfLink",
      "selfLinkWithId",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName =
        olds?.networkAttachmentName ?? output?.networkAttachmentName;
      const nextName = news.networkAttachmentName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      const previousRegion = normalizeRegion(olds?.region ?? output?.region);
      const nextRegion = normalizeRegion(news.region ?? previousRegion);
      if (nameChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (previousRegion !== nextRegion) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const networkAttachmentName = yield* toName(
        id,
        olds?.networkAttachmentName,
        output?.networkAttachmentName,
      );
      const region = normalizeRegion(olds?.region ?? output?.region);
      const existing = yield* getByName(
        env.project,
        region,
        networkAttachmentName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListNetworkAttachments
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.networkAttachments ?? [])
              .filter((item) => hasOwnershipMarker(item.description))
              .map((item) => toAttrs(item, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const networkAttachmentName = yield* toName(
        id,
        news.networkAttachmentName,
        output?.networkAttachmentName,
      );
      const region = normalizeRegion(news.region ?? output?.region);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const subnetworks = news.subnetworks.map((subnet) =>
        toSubnetworkUrl(env.project, region, subnet),
      );
      const connectionPreference = preferenceOf(news.connectionPreference);

      let current = yield* getByName(
        env.project,
        region,
        networkAttachmentName,
      );

      if (current === undefined) {
        yield* compute
          .insertNetworkAttachments({
            project: env.project,
            region,
            body: {
              name: networkAttachmentName,
              description: desiredDescription,
              subnetworks,
              connectionPreference,
              producerAcceptLists: news.producerAcceptLists,
              producerRejectLists: news.producerRejectLists,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitForOperation(
                env.project,
                region,
                operation,
                networkAttachmentName,
                { ignoreAlreadyExists: true },
              ),
            ),
            Effect.catchTag("Conflict", () => Effect.void),
          );
        current = yield* awaitResource(
          env.project,
          region,
          networkAttachmentName,
        );
      }

      const needsPatch =
        (current.description ?? "") !== desiredDescription ||
        preferenceOf(current.connectionPreference) !== connectionPreference ||
        refsKey(current.subnetworks) !== refsKey(subnetworks) ||
        (news.producerAcceptLists !== undefined &&
          refsKey(current.producerAcceptLists) !==
            refsKey(news.producerAcceptLists)) ||
        (news.producerRejectLists !== undefined &&
          refsKey(current.producerRejectLists) !==
            refsKey(news.producerRejectLists));

      if (needsPatch) {
        const latest =
          (yield* getByName(env.project, region, networkAttachmentName)) ??
          current;
        yield* runOp(
          env.project,
          region,
          networkAttachmentName,
          compute.patchNetworkAttachments({
            project: env.project,
            region,
            networkAttachment: networkAttachmentName,
            body: {
              fingerprint: latest.fingerprint,
              description: desiredDescription,
              subnetworks,
              connectionPreference,
              producerAcceptLists:
                news.producerAcceptLists ?? current.producerAcceptLists,
              producerRejectLists:
                news.producerRejectLists ?? current.producerRejectLists,
            },
          }),
        );
        current =
          (yield* getByName(env.project, region, networkAttachmentName)) ??
          current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.networkAttachmentName) return;
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region);
      yield* compute
        .deleteNetworkAttachments({
          project,
          region,
          networkAttachment: output.networkAttachmentName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitForOperation(
              project,
              region,
              operation,
              output.networkAttachmentName,
              { ignoreNotFound: true },
            ),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      yield* waitUntilGone(project, region, output.networkAttachmentName);
    }),
  });
