import * as textract from "@distilled.cloud/aws/textract";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { DetectDocumentText } from "./DetectDocumentText.ts";

export const DetectDocumentTextHttp = Layer.effect(
  DetectDocumentText,
  Effect.gen(function* () {
    const detectDocumentText = yield* textract.detectDocumentText;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Textract.DetectDocumentText())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["textract:DetectDocumentText"],
                // textract:DetectDocumentText has no resource-level IAM
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.Textract.DetectDocumentText")(function* (
        request: textract.DetectDocumentTextRequest,
      ) {
        return yield* detectDocumentText(request);
      });
    });
  }),
);
