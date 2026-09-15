import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  databaseNameOf,
  lastSegment,
  listOwnedDatabaseNames,
  parseDatabaseName,
  toResourceId,
} from "./internal.ts";

const DEFAULT_DATABASE = "(default)";
const DEFAULT_COLLECTION = "_alchemy";

export type DocumentFieldValue = {
  /** UTF-8 string. */
  stringValue?: string;
  /** Integer encoded as a decimal string. */
  integerValue?: string;
  /** Boolean. */
  booleanValue?: boolean;
  /** IEEE 754 double. */
  doubleValue?: number;
  /** RFC3339 timestamp. */
  timestampValue?: string;
  /** Null sentinel (`NULL_VALUE`). */
  nullValue?: string;
};

export type DocumentProps = {
  /**
   * Database id or `projects/{project}/databases/{database}`. Defaults
   * to `"(default)"`. Immutable — changing it replaces the document.
   * @default "(default)"
   */
  database?: string;
  /**
   * Collection id relative to `parent`. Immutable — changing it
   * replaces the document.
   * @default "_alchemy"
   */
  collectionId?: string;
  /**
   * Parent document path relative to the database (no leading slash),
   * or empty for a root collection. Immutable — changing it replaces
   * the document.
   */
  parentPath?: string;
  /**
   * Client-assigned document id. If omitted, a unique id is generated
   * from the stack, stage, and logical id. Immutable — changing it
   * replaces the document.
   */
  documentId?: string;
  /**
   * User fields. Alchemy ownership fields (`alchemy_stack`,
   * `alchemy_stage`, `alchemy_id`) are merged in automatically and
   * stripped from attributes.
   */
  fields?: Record<string, DocumentFieldValue>;
};

export type Document = Resource<
  "GCP.Firestore.Document",
  DocumentProps,
  {
    /** Full resource name `projects/{project}/databases/{database}/documents/{path}`. */
    name: string;
    /** Document id (last path segment). */
    documentId: string;
    /** Database resource name. */
    database: string;
    /** Database id. */
    databaseId: string;
    /** Collection id. */
    collectionId: string;
    /** Parent path relative to the database documents root. */
    parentPath: string;
    /** Path relative to the database documents root. */
    documentPath: string;
    /** Project id. */
    project: string;
    /** User fields (Alchemy ownership fields stripped). */
    fields: Record<string, DocumentFieldValue>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Firestore document.
 *
 * Documents have no labels field, so Alchemy stamps ownership into
 * `alchemy_stack` / `alchemy_stage` / `alchemy_id` fields. Changing
 * `database`, `collectionId`, `parentPath`, or `documentId` replaces
 * the document. User fields update in place via `documents.patch`.
 *
 * Runtime get/patch/delete of arbitrary documents still goes through
 * {@link GetDocument} / {@link PatchDocument} / {@link DeleteDocument}.
 *
 * ### Creating a Document
 * **Example:** Generated id in `_alchemy`
 * ```typescript
 * const doc = yield* GCP.Firestore.Document("Flag", {
 *   fields: { env: { stringValue: "test" } },
 * });
 * ```
 *
 * **Example:** Named document
 * ```typescript
 * const doc = yield* GCP.Firestore.Document("Alice", {
 *   database: "(default)",
 *   collectionId: "users",
 *   documentId: "alice",
 *   fields: { name: { stringValue: "Alice" } },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Firestore
 */
export const Document = Resource<Document>("GCP.Firestore.Document");

export class DocumentNotResolved extends Data.TaggedError(
  "GCP.Firestore.DocumentNotResolved",
)<{
  name: string;
}> {}

const OWNERSHIP_FIELDS = new Set([
  "alchemy_stack",
  "alchemy_stage",
  "alchemy_id",
]);

const databaseIdOf = (value: string | undefined, project: string) => {
  if (value === undefined || value.length === 0) return DEFAULT_DATABASE;
  return parseDatabaseName(databaseNameOf(project, value)).databaseId;
};

const collectionOf = (value: string | undefined) =>
  value && value.length > 0 ? value : DEFAULT_COLLECTION;

const parentPathOf = (value: string | undefined) =>
  (value ?? "").replace(/^\/+|\/+$/g, "");

const documentsParent = (databaseName: string, parentPath: string) =>
  parentPath.length === 0
    ? `${databaseName}/documents`
    : `${databaseName}/documents/${parentPath}`;

const documentName = (
  databaseName: string,
  parentPath: string,
  collectionId: string,
  documentId: string,
) =>
  `${documentsParent(databaseName, parentPath)}/${collectionId}/${documentId}`;

const parseDocumentName = (name: string) => {
  const marker = "/documents/";
  const at = name.indexOf(marker);
  const databaseName = at >= 0 ? name.slice(0, at) : name;
  const relative = at >= 0 ? name.slice(at + marker.length) : lastSegment(name);
  const parts = relative.split("/").filter((part) => part.length > 0);
  const documentId = parts[parts.length - 1] ?? "";
  const collectionId =
    parts.length >= 2 ? parts[parts.length - 2]! : DEFAULT_COLLECTION;
  const parentParts = parts.slice(0, Math.max(0, parts.length - 2));
  return {
    ...parseDatabaseName(databaseName),
    databaseName,
    documentPath: relative,
    documentId,
    collectionId,
    parentPath: parentParts.join("/"),
  };
};

const fieldOf = (value: firestore.Value | undefined): DocumentFieldValue => ({
  stringValue: value?.stringValue,
  integerValue: value?.integerValue,
  booleanValue: value?.booleanValue,
  doubleValue: value?.doubleValue,
  timestampValue: value?.timestampValue,
  nullValue: value?.nullValue,
});

const userFields = (
  fields: firestore.ValueMap | undefined,
): Record<string, DocumentFieldValue> => {
  const next: Record<string, DocumentFieldValue> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (OWNERSHIP_FIELDS.has(key)) continue;
    next[key] = fieldOf(value);
  }
  return next;
};

const ownershipFromFields = (
  fields: firestore.ValueMap | undefined,
): Record<string, string> => {
  const labels: Record<string, string> = {};
  const stack = fields?.alchemy_stack?.stringValue;
  const stage = fields?.alchemy_stage?.stringValue;
  const id = fields?.alchemy_id?.stringValue;
  if (stack) labels[alchemyLabelKeys.stack] = stack;
  if (stage) labels[alchemyLabelKeys.stage] = stage;
  if (id) labels[alchemyLabelKeys.id] = id;
  return labels;
};

const desiredFields = (
  news: DocumentProps,
  labels: Record<string, string>,
): firestore.ValueMap => {
  const fields: firestore.ValueMap = {
    alchemy_stack: { stringValue: labels[alchemyLabelKeys.stack] ?? "" },
    alchemy_stage: { stringValue: labels[alchemyLabelKeys.stage] ?? "" },
    alchemy_id: { stringValue: labels[alchemyLabelKeys.id] ?? "" },
  };
  for (const [key, value] of Object.entries(news.fields ?? {})) {
    if (OWNERSHIP_FIELDS.has(key)) continue;
    fields[key] = value;
  }
  return fields;
};

const jsonOf = (value: unknown) => JSON.stringify(value ?? null);

const toAttrs = (current: firestore.Document, project: string) => {
  const name = current.name ?? "";
  const parsed = parseDocumentName(name);
  return {
    name,
    documentId: parsed.documentId,
    database: parsed.databaseName,
    databaseId: parsed.databaseId,
    collectionId: parsed.collectionId,
    parentPath: parsed.parentPath,
    documentPath: parsed.documentPath,
    project: parsed.project || project,
    fields: userFields(current.fields),
    createTime: current.createTime,
    updateTime: current.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : firestore
        .getProjectsDatabasesDocuments({ name })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed(undefined),
          ),
        );

const listAt = (parent: string, collectionId: string) =>
  parent.length === 0 || collectionId.length === 0
    ? Effect.succeed([] as firestore.Document[])
    : firestore.listProjectsDatabasesDocuments
        .pages({ parent, collectionId, pageSize: 300 })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.documents ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed([] as firestore.Document[]),
          ),
        );

export const DocumentProvider = () =>
  Provider.succeed(Document, {
    stables: [
      "name",
      "documentId",
      "database",
      "databaseId",
      "collectionId",
      "parentPath",
      "documentPath",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousDatabase = olds?.database ?? output?.databaseId;
      const previousCollection = olds?.collectionId ?? output?.collectionId;
      const previousParent = olds?.parentPath ?? output?.parentPath;
      const previousId = olds?.documentId ?? output?.documentId;
      if (
        (previousDatabase !== undefined &&
          news.database !== undefined &&
          news.database !== previousDatabase) ||
        (previousCollection !== undefined &&
          news.collectionId !== undefined &&
          news.collectionId !== previousCollection) ||
        (previousParent !== undefined &&
          news.parentPath !== undefined &&
          parentPathOf(news.parentPath) !== parentPathOf(previousParent)) ||
        (previousId !== undefined &&
          news.documentId !== undefined &&
          news.documentId !== previousId)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const databaseId = databaseIdOf(
        olds?.database ?? output?.database ?? output?.databaseId,
        env.project,
      );
      const databaseName = databaseNameOf(env.project, databaseId);
      const collectionId = collectionOf(
        olds?.collectionId ?? output?.collectionId,
      );
      const parentPath = parentPathOf(olds?.parentPath ?? output?.parentPath);
      const documentId = yield* toResourceId(
        id,
        olds?.documentId,
        output?.documentId,
      );
      const name =
        output?.name ??
        documentName(databaseName, parentPath, collectionId, documentId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const labels = ownershipFromFields(existing.fields);
      return (yield* hasAlchemyLabels(id, tagRecord(labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const owned = yield* listOwnedDatabaseNames(env.project);
        const defaultName = databaseNameOf(env.project, DEFAULT_DATABASE);
        const databases = Array.from(new Set([...owned, defaultName]));
        const pages = yield* Effect.forEach(
          databases,
          (databaseName) =>
            listAt(`${databaseName}/documents`, DEFAULT_COLLECTION).pipe(
              Effect.map((documents) =>
                documents
                  .filter((document) =>
                    Object.keys(ownershipFromFields(document.fields)).some(
                      (key) => key.startsWith("alchemy-"),
                    ),
                  )
                  .map((document) => toAttrs(document, env.project)),
              ),
            ),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const databaseId = databaseIdOf(
        news.database ?? output?.database ?? output?.databaseId,
        env.project,
      );
      const databaseName = databaseNameOf(env.project, databaseId);
      const collectionId = collectionOf(news.collectionId);
      const parentPath = parentPathOf(news.parentPath);
      const documentId = yield* toResourceId(
        id,
        news.documentId,
        output?.documentId,
      );
      const parent = documentsParent(databaseName, parentPath);
      const name = documentName(
        databaseName,
        parentPath,
        collectionId,
        documentId,
      );
      const labels = yield* createInternalLabels(id);
      const fields = desiredFields(news, labels);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* firestore
          .createDocumentProjectsDatabasesDocuments({
            parent,
            collectionId,
            documentId,
            body: { fields },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DocumentNotResolved({ name });
      }

      if (jsonOf(current.fields) !== jsonOf(fields)) {
        current = yield* firestore.patchProjectsDatabasesDocuments({
          name: current.name ?? name,
          "updateMask.fieldPaths": Object.keys(fields),
          body: { fields },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* firestore
        .deleteProjectsDatabasesDocuments({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
