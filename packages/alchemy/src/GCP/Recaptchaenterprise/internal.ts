import * as recaptchaenterprise from "@distilled.cloud/gcp/recaptchaenterprise_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_DESCRIPTION_LENGTH = 256;
export const MAX_DISPLAY_NAME_LENGTH = 63;
export const MAX_PATH_LENGTH = 200;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const projectParent = (project: string) => `projects/${project}`;

export const keyNameOf = (project: string, keyId: string) =>
  `projects/${project}/keys/${keyId}`;

export const firewallNameOf = (project: string, firewallpolicyId: string) =>
  `projects/${project}/firewallpolicies/${firewallpolicyId}`;

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sortedStrings = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

export const stringList = (
  values: readonly (string | undefined)[] | null | undefined,
): string[] =>
  (values ?? []).filter((value): value is string => typeof value === "string");

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = markerOf(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
  maxLength = MAX_DESCRIPTION_LENGTH,
): string => {
  const trimmed = description?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseDescription = (
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
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, description: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseDescription(description);
    if (!hasOwnershipMarker(description)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    return yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
  });

export const toGeneratedPath = (id: string, requested: string | undefined) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
    });
    const path = `/alc/${generated}`.slice(0, MAX_PATH_LENGTH);
    return path.length > 0 ? path : "/alc";
  });

export const getKey = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : recaptchaenterprise
        .getProjectsKeys({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getFirewallPolicy = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : recaptchaenterprise
        .getProjectsFirewallpolicies({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listKeys = (project: string) =>
  recaptchaenterprise.listProjectsKeys
    .pages({
      parent: projectParent(project),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.keys ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );

export const listFirewallPolicies = (project: string) =>
  recaptchaenterprise.listProjectsFirewallpolicies
    .pages({
      parent: projectParent(project),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.firewallPolicies ?? []),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("Forbidden", () => Effect.succeed([])),
    );

export const findOwnedKey = (project: string, id: string, name?: string) =>
  Effect.gen(function* () {
    if (name !== undefined && name.length > 0) {
      const existing = yield* getKey(name);
      if (existing !== undefined) return existing;
    }
    const keys = yield* listKeys(project);
    for (const key of keys) {
      if (yield* hasAlchemyLabels(id, tagRecord(key.labels))) {
        return key;
      }
    }
    return undefined;
  });

export const findOwnedFirewallPolicy = (
  project: string,
  id: string,
  name?: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined && name.length > 0) {
      const existing = yield* getFirewallPolicy(name);
      if (existing !== undefined) return existing;
    }
    const policies = yield* listFirewallPolicies(project);
    for (const policy of policies) {
      if (yield* ownedByAlchemy(id, policy.description)) {
        return policy;
      }
    }
    return undefined;
  });
