import * as speech from "@distilled.cloud/gcp/speech_v1";
import * as Layer from "effect/Layer";
import { makeCustomClassHttpBinding } from "./BindingHttp.ts";
import {
  GetCustomClasse,
  type GetCustomClasseRequest,
} from "./GetCustomClasse.ts";

/**
 * HTTP implementation of {@link GetCustomClasse}.
 *
 * @layer
 * @provides GCP.Speech.GetCustomClasse
 */
export const GetCustomClasseHttp = Layer.effect(
  GetCustomClasse,
  makeCustomClassHttpBinding<
    speech.GetProjectsLocationsCustomClassesRequest,
    speech.CustomClass,
    speech.GetProjectsLocationsCustomClassesError,
    GetCustomClasseRequest
  >({
    tag: "GCP.Speech.GetCustomClasse",
    operation: speech.getProjectsLocationsCustomClasses,
    toInput: (name) => ({ name }),
  }),
);

/** Alias matching the Speech-to-Text API type name. */
export const GetCustomClassHttp = GetCustomClasseHttp;
