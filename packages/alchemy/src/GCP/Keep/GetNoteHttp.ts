import * as keep from "@distilled.cloud/gcp/keep_v1";
import * as Layer from "effect/Layer";
import { makeKeepNoteHttpBinding } from "./BindingHttp.ts";
import { GetNote } from "./GetNote.ts";

/**
 * HTTP implementation of {@link GetNote}.
 *
 * @layer
 * @provides GCP.Keep.GetNote
 */
export const GetNoteHttp = Layer.effect(
  GetNote,
  makeKeepNoteHttpBinding({
    tag: "GCP.Keep.GetNote",
    operation: keep.getNotes,
  }),
);
