import * as billingbudgets from "@distilled.cloud/gcp/billingbudgets_v1";
import * as cloudbilling from "@distilled.cloud/gcp/cloudbilling_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createHash } from "node:crypto";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_DISPLAY_NAME_LENGTH = 60;

export class BillingAccountNotResolved extends Data.TaggedError(
  "GCP.Billingbudgets.BillingAccountNotResolved",
)<{
  project: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const billingAccountIdOf = (value: string) => lastSegment(value);

export const billingAccountParent = (billingAccountId: string) =>
  billingAccountId.startsWith("billingAccounts/")
    ? billingAccountId
    : `billingAccounts/${billingAccountId}`;

export const budgetNameOf = (billingAccountId: string, budgetId: string) =>
  `${billingAccountParent(billingAccountId)}/budgets/${budgetId}`;

export const parseBudgetName = (
  name: string,
  fallbackAccount = "",
): { billingAccountId: string; budgetId: string } => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const accountsAt = parts.indexOf("billingAccounts");
  const budgetsAt = parts.indexOf("budgets");
  return {
    billingAccountId:
      accountsAt >= 0 && parts[accountsAt + 1]
        ? parts[accountsAt + 1]!
        : fallbackAccount,
    budgetId:
      budgetsAt >= 0 && parts[budgetsAt + 1]
        ? parts[budgetsAt + 1]!
        : lastSegment(name),
  };
};

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

export const ownershipHash = (labels: Record<string, string>): string =>
  createHash("sha256")
    .update(
      [
        labels[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 16);

export const fitMarker = (
  labels: Record<string, string>,
  maxLength: number,
) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (id.length >= stack.length && id.length >= stage.length) {
      id = id.slice(0, -1);
    } else if (stack.length >= stage.length) {
      stack = stack.slice(0, -1);
    } else {
      stage = stage.slice(0, -1);
    }
    marker = markerOf(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

/**
 * Budget displayName is capped at 60 characters, so ownership is a
 * short `[alchemy h=<16 hex>]` stamp rather than the full
 * alchemy-stack/stage/id triple used by Logging sinks.
 */
export const encodeDisplayName = (
  labels: Record<string, string>,
  displayName: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
) =>
  Effect.sync(() => {
    const marker = `[alchemy h=${ownershipHash(labels)}]`;
    const trimmed = displayName?.replace(/[\r\n]+/g, " ").trim();
    if (!trimmed) return marker.slice(0, maxLength);
    return `${marker} ${trimmed}`.slice(0, maxLength);
  });

export const parseDisplayName = (
  displayName: string | undefined,
): {
  labels: Record<string, string>;
  hash: string | undefined;
  displayName: string | undefined;
} => {
  if (!displayName?.startsWith("[alchemy ")) {
    return { labels: {}, hash: undefined, displayName };
  }
  const end = displayName.indexOf("]");
  if (end < 0) return { labels: {}, hash: undefined, displayName };
  const labels: Record<string, string> = {};
  let hash: string | undefined;
  for (const part of displayName.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      const key = part.slice(0, eq);
      const value = part.slice(eq + 1);
      if (key === "h") hash = value;
      else labels[key] = value;
    }
  }
  const rest = displayName.slice(end + 1).trim();
  return {
    labels,
    hash,
    displayName: rest.length > 0 ? rest : undefined,
  };
};

export const hasOwnershipMarker = (displayName: string | undefined) => {
  const parsed = parseDisplayName(displayName);
  return (
    parsed.hash !== undefined ||
    Object.keys(parsed.labels).some((key) => key.startsWith("alchemy-"))
  );
};

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, displayName: string | undefined) =>
  Effect.gen(function* () {
    if (!hasOwnershipMarker(displayName)) return false;
    const expected = yield* createInternalLabels(id);
    const parsed = parseDisplayName(displayName);
    if (parsed.hash !== undefined) {
      const hash = yield* Effect.sync(() => ownershipHash(expected));
      return parsed.hash === hash;
    }
    const exact = yield* hasAlchemyLabels(id, parsed.labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        parsed.labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        parsed.labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        parsed.labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const lookupProjectBillingAccountId = (project: string) =>
  cloudbilling.getBillingInfoProjects({ name: `projects/${project}` }).pipe(
    Effect.map((info) =>
      info.billingAccountName
        ? billingAccountIdOf(info.billingAccountName)
        : undefined,
    ),
    Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed(undefined)),
  );

export const resolveBillingAccountId = (
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) {
      return billingAccountIdOf(explicit);
    }
    if (existing !== undefined && existing.length > 0) {
      return billingAccountIdOf(existing);
    }
    const env = yield* GcpEnvironment.current;
    const resolved = yield* lookupProjectBillingAccountId(env.project);
    if (resolved === undefined) {
      return yield* new BillingAccountNotResolved({ project: env.project });
    }
    return resolved;
  });

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

export const sortedStrings = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

export const toProjectNumberRef = (value: string) => {
  const id = lastSegment(value);
  if (/^\d+$/.test(id)) return Effect.succeed(`projects/${id}`);
  return resourcemanager.getProjects({ name: `projects/${id}` }).pipe(
    Effect.map((project) => project.name ?? `projects/${id}`),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed(`projects/${id}`),
    ),
  );
};

export const resolveProjectRefs = (projects: readonly string[] | undefined) =>
  projects === undefined
    ? Effect.succeed(undefined as string[] | undefined)
    : Effect.forEach(projects, toProjectNumberRef);

export const filterChanged = (
  observed: Record<string, unknown> | undefined,
  desired: Record<string, unknown> | undefined,
) => {
  if (desired === undefined) return false;
  const left = observed ?? {};
  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined) continue;
    if (!jsonEqual(left[key], value)) return true;
  }
  return false;
};

export const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;

export const projectScope = (project: string) =>
  project.startsWith("projects/") ? project : `projects/${project}`;

export const getBudget = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : billingbudgets.getBillingAccountsBudgets({ name }).pipe(
        // Missing budgets return 403 "The caller does not have permission"
        // rather than 404.
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          Effect.succeed(undefined),
        ),
      );

export const listBudgets = (parent: string, scope?: string) =>
  parent.length === 0
    ? Effect.succeed([] as billingbudgets.GoogleCloudBillingBudgetsV1Budget[])
    : billingbudgets.listBillingAccountsBudgets
        .pages({
          parent,
          pageSize: 100,
          scope,
        })
        .pipe(
          Stream.take(10),
          Stream.flatMap((page) => Stream.fromIterable(page.budgets ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed(
              [] as billingbudgets.GoogleCloudBillingBudgetsV1Budget[],
            ),
          ),
        );

export const findOwnedBudget = (
  parent: string,
  id: string,
  budgetId?: string,
) =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    const budgets = yield* listBudgets(parent, projectScope(env.project));
    for (const budget of budgets) {
      if (
        budgetId &&
        parseBudgetName(budget.name ?? "").budgetId !== budgetId
      ) {
        continue;
      }
      if (!(yield* ownedByAlchemy(id, budget.displayName))) continue;
      if (!budget.name) continue;
      return yield* getBudget(budget.name);
    }
    return undefined;
  });
