import type * as keep from "@distilled.cloud/gcp/keep_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Note } from "./Note.ts";

export interface GetNoteRequest extends Omit<keep.GetNotesRequest, "name"> {}

/**
 * Runtime binding for Keep `notes.get`.
 *
 * Bind this operation to a {@link Note} in a Function/Action init
 * phase. Provide {@link GetNoteHttp}.
 *
 * ### Reading Notes
 * **Example:** Read note metadata
 * ```typescript
 * const getNote = yield* GCP.Keep.GetNote(note);
 * const metadata = yield* getNote({});
 * ```
 *
 * @binding
 * @product GCP
 * @category Keep
 */
export interface GetNote extends Binding.Service<
  GetNote,
  "GCP.Keep.GetNote",
  (
    note: Note,
  ) => Effect.Effect<
    (
      request: GetNoteRequest,
    ) => Effect.Effect<keep.Note, keep.GetNotesError, RuntimeContext>
  >
> {}

export const GetNote = Binding.Service<GetNote>("GCP.Keep.GetNote");
