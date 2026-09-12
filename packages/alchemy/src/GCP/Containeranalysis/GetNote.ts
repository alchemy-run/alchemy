import type * as containeranalysis from "@distilled.cloud/gcp/containeranalysis_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Note } from "./Note.ts";

export interface GetNoteRequest extends Omit<
  containeranalysis.GetProjectsNotesRequest,
  "name"
> {}

/**
 * Runtime binding for Container Analysis `notes.get`.
 *
 * Bind this operation to a {@link Note} in a Function/Action init
 * phase. Provide {@link GetNoteHttp}.
 *
 * ### Reading a Note
 * **Example:** Get the bound note
 * ```typescript
 * const getNote = yield* GCP.Containeranalysis.GetNote(note);
 * const live = yield* getNote();
 * ```
 *
 * @binding
 * @product GCP
 * @category Containeranalysis
 */
export interface GetNote extends Binding.Service<
  GetNote,
  "GCP.Containeranalysis.GetNote",
  (
    note: Note,
  ) => Effect.Effect<
    (
      request?: GetNoteRequest,
    ) => Effect.Effect<
      containeranalysis.Note,
      containeranalysis.GetProjectsNotesError,
      RuntimeContext
    >
  >
> {}

export const GetNote = Binding.Service<GetNote>(
  "GCP.Containeranalysis.GetNote",
);
