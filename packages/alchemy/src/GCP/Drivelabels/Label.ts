import * as drivelabels from "@distilled.cloud/gcp/drivelabels_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  applyDelta,
  DEFAULT_LABEL_TYPE,
  disableThenDeleteLabel,
  enabledAppsOf,
  encodeOwnership,
  fieldDeltaRequests,
  fieldsOf,
  findOwnedLabel,
  FULL_VIEW,
  getLabel,
  hasOwnershipMarker,
  isDisabled,
  isPublished,
  type LabelField,
  labelIdOf,
  labelResourceName,
  lifecycleStateOf,
  listOwnedLabels,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameText,
  toAdminAccess,
  toEnabledAppSettings,
  toFieldBody,
  toGeneratedName,
} from "./internal.ts";

export type {
  LabelField,
  LabelFieldChoice,
  LabelFieldType,
} from "./internal.ts";

export type LabelProps = {
  /**
   * Server-assigned label id. Immutable — changing it replaces the
   * label.
   */
  labelId?: string;
  /**
   * Display title (max 100 characters). If omitted, a unique title is
   * generated from the stack, stage, and logical id.
   */
  title?: string;
  /**
   * Human-readable description. Drive Labels have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * Label type. Immutable — changing it replaces the label.
   * @default "SHARED"
   */
  labelType?:
    | drivelabels.GoogleAppsDriveLabelsV2LabelLabelTypeEnum
    | (string & {});
  /**
   * Use Workspace admin credentials. Defaults to true for `ADMIN`
   * labels.
   */
  useAdminAccess?: boolean;
  /**
   * BCP-47 language code for localized field labels.
   */
  languageCode?: string;
  /**
   * Custom URL presented to users who want to learn more about the
   * label. Set on create.
   */
  learnMoreUri?: string;
  /**
   * How applied values copy when a Drive item is copied
   * (`DO_NOT_COPY`, `ALWAYS_COPY`, `COPY_APPLIABLE`).
   */
  copyMode?:
    | drivelabels.GoogleAppsDriveLabelsV2LabelAppliedLabelPolicyCopyModeEnum
    | (string & {});
  /**
   * Workspace apps where the label can be used (`DRIVE`, `GMAIL`).
   */
  enabledApps?: string[];
  /**
   * Fields that describe metadata applied with this label.
   */
  fields?: LabelField[];
  /**
   * Publish the latest draft so the label can be applied to Drive
   * items. Published labels cannot return to draft; delete disables
   * them first.
   * @default false
   */
  publish?: boolean;
  /**
   * Disable a published label. Disabled labels stay in Drive but cannot
   * be newly applied, and may be deleted.
   * @default false
   */
  disabled?: boolean;
};

export type Label = Resource<
  "GCP.Drivelabels.Label",
  LabelProps,
  {
    /** Resource name `labels/{id}`. */
    name: string;
    /** Globally unique label id. */
    labelId: string;
    /** Project id used when the label was reconciled. */
    project: string;
    /** Display title. */
    title: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Label type (`SHARED` or `ADMIN`). */
    labelType: string | undefined;
    /** Lifecycle state (`UNPUBLISHED_DRAFT`, `PUBLISHED`, `DISABLED`). */
    lifecycleState: string | undefined;
    /** Whether the latest revision has unpublished changes. */
    hasUnpublishedChanges: boolean;
    /** Revision id of the observed label. */
    revisionId: string | undefined;
    /** Customer that owns the label. */
    customer: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 publish timestamp. */
    publishTime: string | undefined;
    /** RFC3339 disable timestamp. */
    disableTime: string | undefined;
    /** Applied-label copy mode. */
    copyMode: string | undefined;
    /** Learn-more URL. */
    learnMoreUri: string | undefined;
    /** Apps where the label is enabled. */
    enabledApps: string[];
    /** Fields on the label. */
    fields: LabelField[];
    /** Whether admin credentials were used. */
    useAdminAccess: boolean;
  },
  never,
  Providers
>;

/**
 * A Google Drive label taxonomy.
 *
 * Drive Labels have no labels field, so Alchemy stamps ownership into
 * `properties.description` for `list` / nuke. The server-assigned id is
 * identity — changing it or `labelType` replaces the label. Title,
 * description, fields, copy mode, and enabled apps update in place.
 * Draft labels can be deleted directly; published labels are disabled
 * first.
 *
 * ### Creating a Label
 * **Example:** Generated title
 * ```typescript
 * const label = yield* GCP.Drivelabels.Label("Classification", {});
 * ```
 *
 * **Example:** Shared label with a text field
 * ```typescript
 * const label = yield* GCP.Drivelabels.Label("Classification", {
 *   title: "Classification",
 *   description: "Sensitivity of the Drive item",
 *   fields: [{ displayName: "Level", type: "TEXT" }],
 * });
 * ```
 *
 * ### Publishing a Label
 * **Example:** Publish so the label can be applied
 * ```typescript
 * const label = yield* GCP.Drivelabels.Label("Classification", {
 *   title: "Classification",
 *   publish: true,
 * });
 * ```
 *
 * ### Updating a Label
 * **Example:** Rename
 * ```typescript
 * const label = yield* GCP.Drivelabels.Label("Classification", {
 *   labelId: existing.labelId,
 *   title: "Sensitivity",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Drivelabels
 */
export const Label = Resource<Label>("GCP.Drivelabels.Label");

export class LabelNotResolved extends Data.TaggedError(
  "GCP.Drivelabels.LabelNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  label: drivelabels.GoogleAppsDriveLabelsV2Label,
  project: string,
  useAdminAccess: boolean,
) => {
  const parsed = parseOwnership(label.properties?.description);
  return {
    name: labelResourceName(label.name ?? labelIdOf(label)),
    labelId: labelIdOf(label),
    project,
    title: label.properties?.title,
    description: parsed.text,
    labelType: label.labelType,
    lifecycleState: lifecycleStateOf(label),
    hasUnpublishedChanges: label.lifecycle?.hasUnpublishedChanges === true,
    revisionId: label.revisionId,
    customer: label.customer,
    createTime: label.createTime,
    publishTime: label.publishTime,
    disableTime: label.disableTime,
    copyMode: label.appliedLabelPolicy?.copyMode,
    learnMoreUri: label.learnMoreUri,
    enabledApps: enabledAppsOf(label.enabledAppSettings),
    fields: fieldsOf(label.fields),
    useAdminAccess,
  };
};

const refresh = (
  name: string,
  useAdminAccess: boolean,
  fallback: drivelabels.GoogleAppsDriveLabelsV2Label,
) =>
  getLabel(name, useAdminAccess).pipe(Effect.map((fresh) => fresh ?? fallback));

export const LabelProvider = () =>
  Provider.succeed(Label, {
    stables: ["name", "labelId", "project", "customer", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.labelId ?? output?.labelId;
      if (
        previousId !== undefined &&
        news.labelId !== undefined &&
        news.labelId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousType =
        olds?.labelType ?? output?.labelType ?? DEFAULT_LABEL_TYPE;
      const nextType = news.labelType ?? DEFAULT_LABEL_TYPE;
      if (nextType !== previousType) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const useAdminAccess = toAdminAccess(
        olds?.useAdminAccess ?? output?.useAdminAccess,
        olds?.labelType ?? output?.labelType,
      );
      const name = labelResourceName(
        olds?.labelId ?? output?.labelId ?? output?.name ?? "",
      );
      let existing = yield* getLabel(name, useAdminAccess);
      if (existing === undefined) {
        existing = yield* findOwnedLabel(id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, useAdminAccess);
      return (yield* ownedByAlchemy(id, existing.properties?.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwnedLabels();
        return items
          .filter((item) => hasOwnershipMarker(item.properties?.description))
          .map((item) =>
            toAttrs(
              item,
              env.project,
              toAdminAccess(undefined, item.labelType),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const labelType = news.labelType ?? DEFAULT_LABEL_TYPE;
      const useAdminAccess = toAdminAccess(news.useAdminAccess, labelType);
      const ownership = yield* ownershipLabels(id);
      const title = yield* toGeneratedName(id, news.title, output?.title);
      const description = encodeOwnership(ownership, news.description);

      let current = yield* getLabel(
        news.labelId ?? output?.labelId ?? output?.name ?? "",
        useAdminAccess,
      );
      if (current === undefined) {
        current = yield* findOwnedLabel(id);
      }

      if (current === undefined) {
        const created = yield* drivelabels
          .createLabels({
            useAdminAccess,
            languageCode: news.languageCode,
            body: {
              labelType,
              properties: { title, description },
              learnMoreUri: news.learnMoreUri,
              enabledAppSettings: toEnabledAppSettings(news.enabledApps),
              fields: news.fields?.map(toFieldBody),
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwnedLabel(id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new LabelNotResolved({
          name: news.labelId ?? output?.labelId ?? title,
        });
      }

      const name = labelResourceName(current.name ?? labelIdOf(current));
      const published = isPublished(lifecycleStateOf(current));
      const requests: drivelabels.GoogleAppsDriveLabelsV2DeltaUpdateLabelRequestRequest[] =
        [];
      if (
        !sameText(current.properties?.title, title) ||
        !sameText(current.properties?.description, description)
      ) {
        requests.push({
          updateLabel: {
            updateMask: "*",
            properties: { title, description },
          },
        });
      }
      requests.push(
        ...fieldDeltaRequests(current.fields, news.fields, published),
      );
      if (requests.length > 0) {
        const updated = yield* applyDelta(name, useAdminAccess, requests);
        current = updated ?? current;
      }

      if (
        news.copyMode !== undefined &&
        !sameText(current.appliedLabelPolicy?.copyMode, news.copyMode)
      ) {
        current = yield* drivelabels.updateLabelCopyModeLabels({
          name,
          body: {
            useAdminAccess,
            languageCode: news.languageCode,
            view: FULL_VIEW,
            copyMode: news.copyMode,
          },
        });
      }

      if (news.enabledApps !== undefined) {
        const desiredApps = [...news.enabledApps].slice().sort();
        if (
          JSON.stringify(enabledAppsOf(current.enabledAppSettings)) !==
          JSON.stringify(desiredApps)
        ) {
          current = yield* drivelabels.updateLabelEnabledAppSettingsLabels({
            name,
            body: {
              useAdminAccess,
              languageCode: news.languageCode,
              view: FULL_VIEW,
              enabledAppSettings: toEnabledAppSettings(news.enabledApps),
            },
          });
        }
      }

      const state = lifecycleStateOf(current);
      if (
        news.publish === true &&
        (state === "UNPUBLISHED_DRAFT" ||
          current.lifecycle?.hasUnpublishedChanges === true)
      ) {
        current = yield* drivelabels.publishLabels({
          name,
          body: {
            useAdminAccess,
            languageCode: news.languageCode,
          },
        });
      }

      if (news.disabled === true && lifecycleStateOf(current) === "PUBLISHED") {
        current = yield* drivelabels.disableLabels({
          name,
          body: {
            useAdminAccess,
            languageCode: news.languageCode,
            updateMask: "*",
            disabledPolicy: { hideInSearch: true, showInApply: false },
          },
        });
      }

      if (news.disabled === false && isDisabled(lifecycleStateOf(current))) {
        current = yield* drivelabels.enableLabels({
          name,
          body: {
            useAdminAccess,
            languageCode: news.languageCode,
          },
        });
      }

      const fresh = yield* refresh(name, useAdminAccess, current);
      return toAttrs(fresh, env.project, useAdminAccess);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* disableThenDeleteLabel(
        output.name || output.labelId,
        output.useAdminAccess,
      );
    }),
  });
