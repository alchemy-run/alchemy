import * as Stackit from "@alchemy.run/stackit";

/** The token inference requests sign with. It reaches every shared model in its region. */
export const Inference = Stackit.ModelServing.Token("Inference", {});

/** The cheapest chat model, on STACKIT's list read 2026-11-01. It may retire over time. */
export const MODEL = "openai/gpt-oss-20b";
