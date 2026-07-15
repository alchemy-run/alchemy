import * as polly from "@distilled.cloud/aws/polly";
import * as Layer from "effect/Layer";
import { makePollyHttpBinding } from "./BindingHttp.ts";
import { ListLexicons } from "./ListLexicons.ts";

export const ListLexiconsHttp = Layer.effect(
  ListLexicons,
  makePollyHttpBinding<
    polly.ListLexiconsInput,
    polly.ListLexiconsOutput,
    polly.ListLexiconsError
  >({
    capability: "ListLexicons",
    iamActions: ["polly:ListLexicons"],
    operation: polly.listLexicons,
  }),
);
