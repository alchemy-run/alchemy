import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Database } from "./Database.ts";
import { makeDocumentHttpBinding } from "./DocumentHttp.ts";

export interface GetDocumentRequest extends Omit<
  firestore.GetProjectsDatabasesDocumentsRequest,
  "name"
> {
  /**
   * Document path relative to the database, e.g. `users/alice`.
   */
  documentPath: string;
}

/**
 * Runtime binding for Firestore `documents.get`.
 *
 * Bind this operation to a {@link Database} in a Function/Action init
 * phase. Provide {@link GetDocumentHttp}.
 *
 * ### Reading Documents
 * **Example:** Get a document
 * ```typescript
 * const getDocument = yield* GCP.Firestore.GetDocument(database);
 * const doc = yield* getDocument({ documentPath: "users/alice" });
 * ```
 *
 * @binding
 * @category Firestore
 */
export interface GetDocument extends Binding.Service<
  GetDocument,
  "GCP.Firestore.GetDocument",
  (
    database: Database,
  ) => Effect.Effect<
    (
      request: GetDocumentRequest,
    ) => Effect.Effect<
      firestore.Document,
      firestore.GetProjectsDatabasesDocumentsError,
      RuntimeContext
    >
  >
> {}

export const GetDocument = Binding.Service<GetDocument>("GCP.Firestore.GetDocument");

/**
 * HTTP implementation of {@link GetDocument}.
 *
 * @layer
 * @provides GCP.Firestore.GetDocument
 */
export const GetDocumentHttp = Layer.effect(
  GetDocument,
  makeDocumentHttpBinding({
    tag: "GCP.Firestore.GetDocument",
    iam: { role: "roles/datastore.viewer", scopeByCondition: true },
    operation: firestore.getProjectsDatabasesDocuments,
  }),
);
