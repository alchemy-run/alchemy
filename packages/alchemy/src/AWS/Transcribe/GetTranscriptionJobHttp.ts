import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { GetTranscriptionJob } from "./GetTranscriptionJob.ts";

export const GetTranscriptionJobHttp = Layer.effect(
  GetTranscriptionJob,
  Effect.gen(function* () {
    const getTranscriptionJob = yield* transcribe.getTranscriptionJob;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Transcribe.GetTranscriptionJob())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["transcribe:GetTranscriptionJob"],
                  // transcribe:GetTranscriptionJob has no resource-level IAM
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn("AWS.Transcribe.GetTranscriptionJob")(function* (
        request: transcribe.GetTranscriptionJobRequest,
      ) {
        return yield* getTranscriptionJob(request);
      });
    });
  }),
);
