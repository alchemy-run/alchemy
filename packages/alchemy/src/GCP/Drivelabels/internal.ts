import * as drivelabels from "@distilled.cloud/gcp/drivelabels_v2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_TITLE_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 5000;
export const DEFAULT_LABEL_TYPE = "SHARED";
export const FULL_VIEW = "LABEL_VIEW_FULL";

export type LabelFieldType = "TEXT" | "INTEGER" | "DATE" | "USER" | "SELECTION";

export type LabelFieldChoice = {
  /** Server-assigned choice id. */
  id?: string;
  /** Display text for the choice. */
  displayName: string;
};

export type LabelField = {
  /** Server-assigned field id. */
  id?: string;
  /** Display name shown in the Drive UI. */
  displayName: string;
  /**
   * Whether the field is required when applying the label.
   * @default false
   */
  required?: boolean;
  /**
   * Field type. Immutable after the field is published.
   * @default "TEXT"
   */
  type?: LabelFieldType;
  /** Selection choices. Only used when `type` is `SELECTION`. */
  choices?: LabelFieldChoice[];
};

export type LabelDisabledPolicy = {
  hideInSearch?: boolean;
  showInApply?: boolean;
};

const markerOf = (
  _labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(labels, stack, stage, id);
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
    marker = markerOf(labels, stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DESCRIPTION_LENGTH,
): string => {
  const trimmed = text?.trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker}\n${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) => {
  if (
    Object.keys(parseOwnership(text).labels).some((key) =>
      key.startsWith("alchemy-"),
    )
  ) {
    return true;
  }
  return (text ?? "").toLowerCase().includes("alchemy-");
};

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
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

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameBoolean = (
  left: boolean | undefined,
  right: boolean | undefined,
) => (left ?? false) === (right ?? false);

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const toGeneratedName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_TITLE_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.slice(0, maxLength);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing.slice(0, maxLength);
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `l${generated}`.slice(0, maxLength);
    return next.length >= 4 ? next : `${next}xxxx`.slice(0, maxLength);
  });

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "").split("@")[0] ?? value;
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const labelResourceName = (idOrName: string) => {
  const trimmed = idOrName.trim();
  if (trimmed.length === 0) return "";
  const withoutRevision = trimmed.split("@")[0] ?? trimmed;
  return withoutRevision.startsWith("labels/")
    ? withoutRevision
    : `labels/${withoutRevision}`;
};

export const labelIdOf = (label: drivelabels.GoogleAppsDriveLabelsV2Label) =>
  label.id ?? lastSegment(label.name ?? "");

export const toAdminAccess = (
  requested: boolean | undefined,
  labelType: string | undefined,
) => requested ?? labelType === "ADMIN";

const emptyList = <A>() => Effect.succeed([] as A[]);

export const fieldTypeOf = (
  field: drivelabels.GoogleAppsDriveLabelsV2Field,
): LabelFieldType => {
  if (field.selectionOptions !== undefined) return "SELECTION";
  if (field.integerOptions !== undefined) return "INTEGER";
  if (field.dateOptions !== undefined) return "DATE";
  if (field.userOptions !== undefined) return "USER";
  return "TEXT";
};

export const choicesOf = (
  field: drivelabels.GoogleAppsDriveLabelsV2Field,
): LabelFieldChoice[] | undefined => {
  const choices = field.selectionOptions?.choices;
  if (choices === undefined) return undefined;
  return choices.map((choice) => ({
    id: choice.id,
    displayName: choice.properties?.displayName ?? "",
  }));
};

export const fieldsOf = (
  fields:
    | readonly drivelabels.GoogleAppsDriveLabelsV2Field[]
    | readonly LabelField[]
    | undefined,
): LabelField[] =>
  (fields ?? []).map((field) => {
    if ("displayName" in field && typeof field.displayName === "string") {
      return {
        id: field.id,
        displayName: field.displayName,
        required: field.required === true,
        type: field.type ?? "TEXT",
        choices: field.choices,
      };
    }
    const observed = field as drivelabels.GoogleAppsDriveLabelsV2Field;
    return {
      id: observed.id,
      displayName: observed.properties?.displayName ?? "",
      required: observed.properties?.required === true,
      type: fieldTypeOf(observed),
      choices: choicesOf(observed),
    };
  });

export const toFieldBody = (
  field: LabelField,
): drivelabels.GoogleAppsDriveLabelsV2Field => {
  const type = field.type ?? "TEXT";
  return {
    id: field.id,
    properties: {
      displayName: field.displayName,
      required: field.required === true ? true : undefined,
    },
    textOptions: type === "TEXT" ? {} : undefined,
    integerOptions: type === "INTEGER" ? {} : undefined,
    dateOptions: type === "DATE" ? {} : undefined,
    userOptions: type === "USER" ? {} : undefined,
    selectionOptions:
      type === "SELECTION"
        ? {
            choices: (field.choices ?? []).map((choice) => ({
              id: choice.id,
              properties: { displayName: choice.displayName },
            })),
          }
        : undefined,
  };
};

export const enabledAppsOf = (
  settings:
    | drivelabels.GoogleAppsDriveLabelsV2LabelEnabledAppSettings
    | undefined,
): string[] =>
  (settings?.enabledApps ?? [])
    .map((app) => app.app)
    .filter((app): app is string => typeof app === "string" && app.length > 0)
    .slice()
    .sort();

export const toEnabledAppSettings = (
  apps: readonly string[] | undefined,
): drivelabels.GoogleAppsDriveLabelsV2LabelEnabledAppSettings | undefined => {
  if (apps === undefined) return undefined;
  return {
    enabledApps: apps.map((app) => ({ app })),
  };
};

export const lifecycleStateOf = (
  label: drivelabels.GoogleAppsDriveLabelsV2Label,
) => label.lifecycle?.state;

export const isPublished = (state: string | undefined) =>
  state === "PUBLISHED" || state === "DISABLED";

export const isDisabled = (state: string | undefined) => state === "DISABLED";

export const getLabel = (name: string, useAdminAccess: boolean) => {
  const resourceName = labelResourceName(name);
  return resourceName.length === 0
    ? Effect.succeed(undefined)
    : drivelabels
        .getLabels({
          name: resourceName,
          view: FULL_VIEW,
          useAdminAccess,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed(undefined),
          ),
        );
};

export const listLabels = (useAdminAccess: boolean) =>
  drivelabels.listLabels
    .pages({
      pageSize: 200,
      publishedOnly: false,
      view: FULL_VIEW,
      minimumRole: "READER",
      useAdminAccess,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.labels ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        emptyList<drivelabels.GoogleAppsDriveLabelsV2Label>(),
      ),
    );

export const listOwnedLabels = () =>
  Effect.gen(function* () {
    const [standard, admin] = yield* Effect.all(
      [listLabels(false), listLabels(true)],
      { concurrency: 2 },
    );
    const seen = new Set<string>();
    const owned: drivelabels.GoogleAppsDriveLabelsV2Label[] = [];
    for (const label of [...standard, ...admin]) {
      const key = labelIdOf(label);
      if (key.length === 0 || seen.has(key)) continue;
      if (!hasOwnershipMarker(label.properties?.description)) continue;
      seen.add(key);
      owned.push(label);
    }
    return owned;
  });

export const findOwnedLabel = (id: string) =>
  Effect.gen(function* () {
    const labels = yield* listOwnedLabels();
    for (const label of labels) {
      if (yield* ownedByAlchemy(id, label.properties?.description)) {
        return label;
      }
    }
    return undefined;
  });

export const fieldDeltaRequests = (
  observed: readonly drivelabels.GoogleAppsDriveLabelsV2Field[] | undefined,
  desired: readonly LabelField[] | undefined,
  published: boolean,
): drivelabels.GoogleAppsDriveLabelsV2DeltaUpdateLabelRequestRequest[] => {
  if (desired === undefined) return [];
  const current = fieldsOf(observed);
  const requests: drivelabels.GoogleAppsDriveLabelsV2DeltaUpdateLabelRequestRequest[] =
    [];
  const matched = new Set<string>();

  for (const field of desired) {
    const existing = field.id
      ? current.find((item) => item.id === field.id)
      : current.find((item) => item.displayName === field.displayName);
    if (existing?.id === undefined) {
      requests.push({ createField: { field: toFieldBody(field) } });
      continue;
    }
    matched.add(existing.id);
    const type = field.type ?? existing.type ?? "TEXT";
    if (type !== existing.type && !published) {
      requests.push({
        updateFieldType: {
          id: existing.id,
          updateMask: "*",
          textOptions: type === "TEXT" ? {} : undefined,
          integerOptions: type === "INTEGER" ? {} : undefined,
          dateOptions: type === "DATE" ? {} : undefined,
          userOptions: type === "USER" ? {} : undefined,
          selectionOptions:
            type === "SELECTION"
              ? {
                  choices: (field.choices ?? []).map((choice) => ({
                    id: choice.id,
                    properties: { displayName: choice.displayName },
                  })),
                }
              : undefined,
        },
      });
    }
    if (
      !sameText(existing.displayName, field.displayName) ||
      !sameBoolean(existing.required, field.required)
    ) {
      requests.push({
        updateField: {
          id: existing.id,
          updateMask: "*",
          properties: {
            displayName: field.displayName,
            required: field.required === true ? true : undefined,
          },
        },
      });
    }
    if (type === "SELECTION") {
      const observedChoices = existing.choices ?? [];
      const desiredChoices = field.choices ?? [];
      const used = new Set<string>();
      for (const choice of desiredChoices) {
        const found = choice.id
          ? observedChoices.find((item) => item.id === choice.id)
          : observedChoices.find(
              (item) => item.displayName === choice.displayName,
            );
        if (found?.id === undefined) {
          requests.push({
            createSelectionChoice: {
              fieldId: existing.id,
              choice: {
                properties: { displayName: choice.displayName },
              },
            },
          });
          continue;
        }
        used.add(found.id);
        if (!sameText(found.displayName, choice.displayName)) {
          requests.push({
            updateSelectionChoiceProperties: {
              fieldId: existing.id,
              id: found.id,
              updateMask: "displayName",
              properties: { displayName: choice.displayName },
            },
          });
        }
      }
      for (const choice of observedChoices) {
        if (choice.id === undefined || used.has(choice.id)) continue;
        if (published) {
          requests.push({
            disableSelectionChoice: {
              fieldId: existing.id,
              id: choice.id,
              updateMask: "*",
              disabledPolicy: { hideInSearch: true, showInApply: false },
            },
          });
        } else {
          requests.push({
            deleteSelectionChoice: {
              fieldId: existing.id,
              id: choice.id,
            },
          });
        }
      }
    }
  }

  for (const field of current) {
    if (field.id === undefined || matched.has(field.id)) continue;
    if (published) {
      requests.push({
        disableField: {
          id: field.id,
          updateMask: "*",
          disabledPolicy: { hideInSearch: true, showInApply: false },
        },
      });
    } else {
      requests.push({ deleteField: { id: field.id } });
    }
  }

  return requests;
};

export const applyDelta = (
  name: string,
  useAdminAccess: boolean,
  requests: drivelabels.GoogleAppsDriveLabelsV2DeltaUpdateLabelRequestRequest[],
) => {
  if (requests.length === 0) {
    return getLabel(name, useAdminAccess);
  }
  return drivelabels
    .deltaLabels({
      name: labelResourceName(name),
      body: {
        useAdminAccess,
        view: FULL_VIEW,
        requests,
      },
    })
    .pipe(
      Effect.flatMap((response) =>
        response.updatedLabel !== undefined
          ? Effect.succeed(response.updatedLabel)
          : getLabel(name, useAdminAccess),
      ),
    );
};

export const disableThenDeleteLabel = (name: string, useAdminAccess: boolean) =>
  Effect.gen(function* () {
    const resourceName = labelResourceName(name);
    if (resourceName.length === 0) return;
    const current = yield* getLabel(resourceName, useAdminAccess);
    if (current === undefined) return;
    const state = lifecycleStateOf(current);
    if (state === "PUBLISHED") {
      yield* drivelabels
        .disableLabels({
          name: resourceName,
          body: {
            useAdminAccess,
            updateMask: "*",
            disabledPolicy: { hideInSearch: true, showInApply: false },
          },
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catchTag("Forbidden", () => Effect.void),
          Effect.catchTag("Conflict", () => Effect.void),
        );
    }
    yield* drivelabels.deleteLabels({
      name: resourceName,
      useAdminAccess,
    });
  }).pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "BadRequest" || error._tag === "Conflict",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
    Effect.catchTag("BadRequest", () => Effect.void),
    Effect.catchTag("Conflict", () => Effect.void),
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.catchTag("Forbidden", () => Effect.void),
  );
