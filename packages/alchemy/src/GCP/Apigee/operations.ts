import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import {
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  orgIdOf,
  orgParent,
  parseDescription,
} from "./ownership.ts";

export {
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  orgIdOf,
  orgParent,
  parseDescription,
};

export const orgNameOf = (organization: string) =>
  organization.startsWith("organizations/")
    ? organization
    : `organizations/${organization}`;

export const orgName = orgNameOf;

export const defaultOrgName = (project: string, organization?: string) =>
  orgNameOf(organization ?? project);

export const createOwnership = (id: string) => createInternalLabels(id);

export const ownedBy = (id: string, labels: Record<string, string>) =>
  hasAlchemyLabels(id, labels);

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const jsonEqual = sameJson;

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify([...(left ?? [])].sort()) ===
  JSON.stringify([...(right ?? [])].sort());

export const sortedStrings = (values: readonly string[] | undefined) =>
  [...(values ?? [])].sort();

export const sameRecord = (
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
) => sameJson(left ?? {}, right ?? {});

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = 63,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    let generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    if (!/^[a-z]/.test(generated)) {
      generated = `a${generated}`.slice(0, maxLength);
    }
    return generated.replace(/-+$/g, "") || "resource";
  });

export const letterPrefixedId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = 63,
) => toPhysicalId(id, explicit, existing, maxLength);

export const dcCollectorId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 28,
      lowercase: true,
    });
    const cleaned = generated.replace(/[^a-z0-9]/g, "_");
    return cleaned.startsWith("dc_") ? cleaned : `dc_${cleaned}`;
  });

export const collectPages = <Page, Item, E, R>(
  stream: Stream.Stream<Page, E, R>,
  pick: (page: Page) => readonly Item[] | undefined,
) =>
  stream.pipe(
    Stream.flatMap((page) => Stream.fromIterable(pick(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const listOrgNames = () =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    const page = yield* apigee
      .listOrganizations({ parent: "organizations" })
      .pipe(
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          Effect.succeed({
            organizations:
              [] as apigee.GoogleCloudApigeeV1OrganizationProjectMappingList,
          }),
        ),
      );
    const mappings = (page.organizations ?? []).filter(
      (mapping) =>
        mapping.projectId === env.project ||
        (mapping.projectIds ?? []).includes(env.project),
    );
    const ids =
      mappings.length > 0
        ? mappings.map((mapping) => mapping.organization ?? env.project)
        : [env.project];
    return [...new Set(ids.map(orgNameOf))];
  });

export const resolveOrgId = (project: string) =>
  Effect.gen(function* () {
    const names = yield* listOrgNames();
    return orgIdOf(names[0] ?? project);
  });

export const childName = (parent: string, collection: string, id: string) =>
  `${parent}/${collection}/${lastSegment(id)}`;

const isAttributesObject = (
  value:
    | readonly apigee.GoogleCloudApigeeV1Attribute[]
    | apigee.GoogleCloudApigeeV1Attributes,
): value is apigee.GoogleCloudApigeeV1Attributes => !Array.isArray(value);

export const attributesToRecord = (
  attributes:
    | readonly apigee.GoogleCloudApigeeV1Attribute[]
    | apigee.GoogleCloudApigeeV1Attributes
    | undefined,
): Record<string, string> => {
  const list =
    attributes === undefined
      ? []
      : isAttributesObject(attributes)
        ? (attributes.attribute ?? [])
        : attributes;
  const record: Record<string, string> = {};
  for (const item of list) {
    if (item.name !== undefined) record[item.name] = item.value ?? "";
  }
  return record;
};

export const recordToAttributes = (
  record: Record<string, string>,
): apigee.GoogleCloudApigeeV1Attribute[] =>
  Object.entries(record).map(([name, value]) => ({ name, value }));

export const userAttributes = (record: Record<string, string> | undefined) =>
  Object.fromEntries(
    Object.entries(record ?? {}).filter(([key]) => !key.startsWith("alchemy-")),
  );

export const desiredAttributes = (
  user: Record<string, string> | undefined,
  ownership: Record<string, string>,
) => ({ ...(user ?? {}), ...ownership });

export const propertiesToRecord = (
  properties: apigee.GoogleCloudApigeeV1Properties | undefined,
): Record<string, string> => {
  const record: Record<string, string> = {};
  for (const item of properties?.property ?? []) {
    if (item.name !== undefined) record[item.name] = item.value ?? "";
  }
  return record;
};

export const recordToProperties = (
  record: Record<string, string>,
): apigee.GoogleCloudApigeeV1Properties => ({
  property: Object.entries(record).map(([name, value]) => ({ name, value })),
});

export const userProperties = (
  properties: apigee.GoogleCloudApigeeV1Properties | undefined,
) => userAttributes(propertiesToRecord(properties));

/**
 * Apigee has no `wait*` long-poll. Poll `getOrganizationsOperations` with a
 * hard iteration cap so creates cannot pin the HTTP pool.
 */
export class ApigeeOperationFailed extends Data.TaggedError(
  "GCP.Apigee.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class ApigeeOperationPending extends Data.TaggedError(
  "GCP.Apigee.OperationPending",
)<{
  operation: string;
}> {}

const isNotFoundStatus = (error: apigee.GoogleRpcStatus | undefined) => {
  if (error === undefined) return false;
  if (error.code === 5) return true;
  return (error.message ?? "").toLowerCase().includes("not found");
};

const isAlreadyExists = (error: apigee.GoogleRpcStatus | undefined) => {
  if (error === undefined) return false;
  if (error.code === 6) return true;
  const message = (error.message ?? "").toLowerCase();
  return message.includes("already exists") || message.includes("conflict");
};

const isIgnorable = (
  error: apigee.GoogleRpcStatus | undefined,
  options?: { notFoundOk?: boolean; alreadyExistsOk?: boolean },
) =>
  (options?.alreadyExistsOk === true && isAlreadyExists(error)) ||
  (options?.notFoundOk === true && isNotFoundStatus(error));

export const waitForOperation = (
  operation: apigee.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean; alreadyExistsOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error && !isIgnorable(operation.error, options)) {
        return yield* new ApigeeOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      return yield* new ApigeeOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = apigee.getOrganizationsOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<apigee.GoogleLongrunningOperation>({
                name,
                done: true,
              }),
            ),
          )
        : getOperation.pipe(
            Effect.retry({
              while: (error) => error._tag === "NotFound",
              times: 5,
              schedule: Schedule.exponential("250 millis"),
            }),
          );

    return yield* resolved.pipe(
      Effect.filterOrFail(
        (current) => current.done === true,
        () => new ApigeeOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        if (current.error && !isIgnorable(current.error, options)) {
          return Effect.fail(
            new ApigeeOperationFailed({
              operation: name,
              message: current.error.message ?? "operation failed",
            }),
          );
        }
        return Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Apigee.OperationPending",
        times: 8,
        schedule: Schedule.spaced("5 seconds"),
      }),
    );
  });

const OWNERSHIP_HOST_PREFIX = "alc-";
const OWNERSHIP_HOST_SUFFIX = ".invalid";

const isOwnershipHostname = (hostname: string) =>
  hostname.startsWith(OWNERSHIP_HOST_PREFIX) &&
  hostname.endsWith(OWNERSHIP_HOST_SUFFIX);

export const withOwnershipHostname = (
  hostnames: readonly string[] | undefined,
  ownership: Record<string, string>,
) => {
  const marker = `${OWNERSHIP_HOST_PREFIX}${ownership["alchemy-id"] ?? "x"}${OWNERSHIP_HOST_SUFFIX}`;
  return [
    ...(hostnames ?? []).filter((hostname) => !isOwnershipHostname(hostname)),
    marker,
  ];
};

export const hasOwnershipHostname = (
  hostnames: readonly string[] | undefined,
) => (hostnames ?? []).some(isOwnershipHostname);

export const userHostnames = (hostnames: readonly string[] | undefined) =>
  [...(hostnames ?? [])].filter((hostname) => !isOwnershipHostname(hostname));

export const stringField = (
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const raw = value?.[key];
  return typeof raw === "string" ? raw : undefined;
};
