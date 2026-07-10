import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { StartTranscriptionJob } from "./StartTranscriptionJob.ts";

export const StartTranscriptionJobHttp = Layer.effect(
  StartTranscriptionJob,
  Effect.gen(function* () {
    const startTranscriptionJob = yield* transcribe.startTranscriptionJob;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Transcribe.StartTranscriptionJob())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["transcribe:StartTranscriptionJob"],
                  // transcribe:StartTranscriptionJob has no resource-level IAM
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn("AWS.Transcribe.StartTranscriptionJob")(function* (
        request: transcribe.StartTranscriptionJobRequest,
      ) {
        return yield* startTranscriptionJob(request);
      });
    });
  }),
);
