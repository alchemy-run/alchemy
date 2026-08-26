import * as composer from "@distilled.cloud/gcp/composer_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { hasTags, tagRecord } from "../../Tags.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
} from "../Labels.ts";

export const DEFAULT_LOCATION = "us-central1";
export const MAX_NAME_LENGTH = 63;

/**
 * Composer rejects `locations/-` (`Unexpected location: -`). Nuke walks
 * known Composer regions instead.
 */
export const LIST_LOCATIONS = [
  "africa-south1",
  "asia-east1",
  "asia-east2",
  "asia-northeast1",
  "asia-northeast2",
  "asia-northeast3",
  "asia-south1",
  "asia-south2",
  "asia-southeast1",
  "asia-southeast2",
  "australia-southeast1",
  "australia-southeast2",
  "europe-central2",
  "europe-north1",
  "europe-southwest1",
  "europe-west1",
  "europe-west2",
  "europe-west3",
  "europe-west4",
  "europe-west6",
  "europe-west8",
  "europe-west9",
  "europe-west10",
  "europe-west12",
  "me-central1",
  "me-central2",
  "me-west1",
  "northamerica-northeast1",
  "northamerica-northeast2",
  "southamerica-east1",
  "southamerica-west1",
  "us-central1",
  "us-east1",
  "us-east4",
  "us-east5",
  "us-south1",
  "us-west1",
  "us-west2",
  "us-west3",
  "us-west4",
] as const;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `c${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return "workload";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

export type ParsedWorkloadName = {
  project: string;
  location: string;
  environmentId: string;
  configMapId: string | undefined;
  secretId: string | undefined;
};

export const parseWorkloadName = (name: string): ParsedWorkloadName => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const get = (key: string) => {
    const index = parts.lastIndexOf(key);
    return index >= 0 ? parts[index + 1] : undefined;
  };
  return {
    project: get("projects") ?? "",
    location: get("locations") ?? DEFAULT_LOCATION,
    environmentId: get("environments") ?? lastSegment(name),
    configMapId: get("userWorkloadsConfigMaps"),
    secretId: get("userWorkloadsSecrets"),
  };
};

export const environmentParent = (environmentName: string) => {
  const parsed = parseWorkloadName(environmentName);
  return `projects/${parsed.project}/locations/${parsed.location}/environments/${parsed.environmentId}`;
};

export const mapOf = (
  map: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(map ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

export const dataKey = (
  map: Record<string, string | undefined> | null | undefined,
) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(mapOf(map)).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );

export const userData = (
  data: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(data));

export const hasOwnershipMarker = (
  data: Record<string, string | undefined> | null | undefined,
) => Object.keys(data ?? {}).some((key) => key.startsWith("alchemy-"));

const utf8ToBase64 = (value: string) =>
  Buffer.from(value, "utf8").toString("base64");

export const encodeOwnershipData = (
  ownership: Record<string, string>,
  data: Record<string, string> | undefined,
  options?: { base64?: boolean },
): Record<string, string> => {
  const stamped =
    options?.base64 === true
      ? Object.fromEntries(
          Object.entries(ownership).map(([key, value]) => [
            key,
            utf8ToBase64(value),
          ]),
        )
      : ownership;
  return { ...mapOf(data), ...stamped };
};

export const ownedBy = Effect.fn(function* (
  id: string,
  data: Record<string, string | undefined> | null | undefined,
  kind: "configMap" | "secret",
) {
  const actual = tagRecord(data);
  if (kind === "configMap") {
    return yield* hasAlchemyLabels(id, actual);
  }
  const expected = yield* createInternalLabels(id);
  const encoded = yield* Effect.sync(() =>
    Object.fromEntries(
      Object.entries(expected).map(([key, value]) => [
        key,
        utf8ToBase64(value),
      ]),
    ),
  );
  if (hasTags(encoded, actual)) return true;
  const valuesCleared = Object.values(actual).every(
    (value) => value.length === 0,
  );
  return (
    valuesCleared &&
    Object.hasOwn(actual, alchemyLabelKeys.stack) &&
    Object.hasOwn(actual, alchemyLabelKeys.stage) &&
    Object.hasOwn(actual, alchemyLabelKeys.id)
  );
});

export const isPlaceholderEnvironment = (environment: composer.Environment) => {
  const name = environment.name ?? "";
  return name.endsWith("/environments/-") || name.endsWith("/environments/");
};

export const supportsUserWorkloads = (environment: composer.Environment) => {
  const image = environment.config?.softwareConfig?.imageVersion ?? "";
  return image.includes("composer-3");
};

export const listEnvironmentsAt = (project: string, location: string) =>
  composer.listProjectsLocationsEnvironments
    .pages({
      parent: `projects/${project}/locations/${location}`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.environments ?? [])),
      Stream.filter(
        (environment) =>
          !isPlaceholderEnvironment(environment) &&
          supportsUserWorkloads(environment) &&
          (environment.name ?? "").length > 0,
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
      Effect.catchTag("Forbidden", () => Effect.succeed([])),
    );

export const listAllEnvironments = (project: string) =>
  Effect.gen(function* () {
    const pages = yield* Effect.forEach(
      LIST_LOCATIONS,
      (location) => listEnvironmentsAt(project, location),
      { concurrency: 8 },
    );
    return pages.flat();
  });
