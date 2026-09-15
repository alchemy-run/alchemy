import * as containeranalysis from "@distilled.cloud/gcp/containeranalysis_v1";
import * as Layer from "effect/Layer";
import { makeNoteHttpBinding } from "./BindingHttp.ts";
import { GetNote } from "./GetNote.ts";

/**
 * HTTP implementation of {@link GetNote}.
 *
 * @layer
 * @provides GCP.Containeranalysis.GetNote
 */
export const GetNoteHttp = Layer.effect(
  GetNote,
  makeNoteHttpBinding({
    tag: "GCP.Containeranalysis.GetNote",
    operation: containeranalysis.getProjectsNotes,
  }),
);
