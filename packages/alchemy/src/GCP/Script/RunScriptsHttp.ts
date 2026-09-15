import * as script from "@distilled.cloud/gcp/script_v1";
import * as Layer from "effect/Layer";
import { makeRunScriptsHttpBinding } from "./BindingHttp.ts";
import { RunScripts } from "./RunScripts.ts";

/**
 * HTTP implementation of {@link RunScripts}.
 *
 * @layer
 * @provides GCP.Script.RunScripts
 */
export const RunScriptsHttp = Layer.effect(
  RunScripts,
  makeRunScriptsHttpBinding({
    tag: "GCP.Script.RunScripts",
    operation: script.runScripts,
  }),
);
