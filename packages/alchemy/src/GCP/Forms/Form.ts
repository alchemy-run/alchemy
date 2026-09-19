import * as drive from "@distilled.cloud/gcp/drive_v3";
import * as forms from "@distilled.cloud/gcp/forms_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  hasOwnershipMarker,
  ownedByAlchemy,
  ownedTitle,
  parseTitle,
  ResourceNotResolved,
} from "./internal.ts";

export type FormProps = {
  /**
   * Responder-visible title. Forms have no labels field, so Alchemy
   * stamps ownership into a `[alchemy …]` prefix and strips it from
   * attributes. `documentTitle` is set to the same value on create.
   */
  title?: string;
  /**
   * Form description. Updated in place via `forms.batchUpdate`.
   */
  description?: string;
  /**
   * When true, the form is created unpublished and does not accept
   * responses.
   * @default false
   */
  unpublished?: boolean;
  /**
   * Existing form id. Omit on create; pass the observed id to update
   * in place. Immutable — changing it replaces the form.
   */
  formId?: string;
};

export type Form = Resource<
  "GCP.Forms.Form",
  FormProps,
  {
    /** Form id. */
    formId: string;
    /** Responder-visible title with the Alchemy ownership prefix stripped. */
    title: string | undefined;
    /** Description. */
    description: string | undefined;
    /** Drive document title. */
    documentTitle: string | undefined;
    /** Responder URI. */
    responderUri: string | undefined;
    /** Revision id. */
    revisionId: string | undefined;
    /** Linked response spreadsheet id, if any. */
    linkedSheetId: string | undefined;
    /** Project id used when the form was reconciled. */
    project: string;
  },
  never,
  Providers
>;

/**
 * A Google Form.
 *
 * Forms have no labels — Alchemy stamps ownership into `info.title`.
 * The Forms API has no delete; Alchemy deletes the backing Drive file.
 *
 * Create only copies `info.title` and `info.documentTitle`. Description
 * is applied afterwards with `forms.batchUpdate`.
 *
 * ### Creating a Form
 * **Example:** Titled form
 * ```typescript
 * const form = yield* GCP.Forms.Form("Survey", {
 *   title: "alchemy-survey",
 *   unpublished: true,
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Forms
 */
export const Form = Resource<Form>("GCP.Forms.Form");

export class FormNotResolved extends Data.TaggedError(
  "GCP.Forms.FormNotResolved",
)<{
  formId: string;
}> {}

const toAttrs = (form: forms.Form, project: string) => ({
  formId: form.formId ?? "",
  title: parseTitle(form.info?.title).title,
  description: form.info?.description,
  documentTitle: parseTitle(form.info?.documentTitle).title,
  responderUri: form.responderUri,
  revisionId: form.revisionId,
  linkedSheetId: form.linkedSheetId,
  project,
});

const getById = (formId: string) =>
  formId.length === 0
    ? Effect.succeed(undefined)
    : forms
        .getForms({ formId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwnedForms = () =>
  drive.listFiles
    .pages({
      q: "mimeType='application/vnd.google-apps.form' and trashed=false and name contains '[alchemy '",
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.files ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed([] as drive.File[]),
      ),
    );

export const FormProvider = () =>
  Provider.succeed(Form, {
    stables: ["formId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.formId ?? output?.formId;
      if (
        previousId !== undefined &&
        news.formId !== undefined &&
        news.formId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* getById(olds?.formId ?? output?.formId ?? "");
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.info?.title))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const files = yield* listOwnedForms();
        const formsFound = yield* Effect.forEach(
          files.filter((file) => hasOwnershipMarker(file.name)),
          (file) =>
            file.id
              ? getById(file.id).pipe(
                  Effect.map((form) =>
                    form ? toAttrs(form, env.project) : undefined,
                  ),
                )
              : Effect.succeed(undefined),
          { concurrency: 4 },
        );
        return formsFound.filter(
          (form): form is ReturnType<typeof toAttrs> => form !== undefined,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const title = yield* ownedTitle(
        id,
        news.title,
        parseTitle(output?.title).title,
      );

      let current = yield* getById(news.formId ?? output?.formId ?? "");

      if (current === undefined) {
        current = yield* forms.createForms({
          unpublished: news.unpublished,
          body: {
            info: { title, documentTitle: title },
          },
        });
      }

      if (current === undefined || !current.formId) {
        return yield* new ResourceNotResolved({
          formId: news.formId ?? output?.formId ?? title,
        });
      }

      const titleChanged = current.info?.title !== title;
      const descriptionChanged =
        news.description !== undefined &&
        (current.info?.description ?? "") !== news.description;
      if (titleChanged || descriptionChanged) {
        const updated = yield* forms.batchUpdateForms({
          formId: current.formId,
          body: {
            includeFormInResponse: true,
            requests: [
              {
                updateFormInfo: {
                  info: {
                    title,
                    description: news.description,
                  },
                  updateMask: [
                    titleChanged ? "title" : undefined,
                    descriptionChanged ? "description" : undefined,
                  ]
                    .filter((field): field is string => field !== undefined)
                    .join(","),
                },
              },
            ],
          },
        });
        current = updated.form ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.formId) return;
      yield* drive
        .deleteFiles({ fileId: output.formId, supportsAllDrives: true })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
