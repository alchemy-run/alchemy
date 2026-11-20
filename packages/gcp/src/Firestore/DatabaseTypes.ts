import * as Data from "effect/Data";

/** `create` found a document already at `path`. */
export class DocumentAlreadyExists extends Data.TaggedError("GCP.Firestore.DocumentAlreadyExists")<{
  path: string;
  message: string;
}> {}
