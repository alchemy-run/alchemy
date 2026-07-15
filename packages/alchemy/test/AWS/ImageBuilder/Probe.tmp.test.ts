// Temporary probe: exact tags for get/delete/cancel on a nonexistent image.
import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import * as Test from "@/Test/Vitest";
import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

const show = (label: string, result: Result.Result<unknown, unknown>) => {
  if (Result.isFailure(result)) {
    const e = result.failure as any;
    console.log(
      `${label}: tag=${e?._tag} msg=${e?.message} json=${JSON.stringify(e)?.slice(0, 300)}`,
    );
  } else {
    console.log(`${label}: succeeded`);
  }
};

test.provider("probe nonexistent image error tags", () =>
  Effect.gen(function* () {
    const { accountId, region } = yield* AWSEnvironment.current;
    const arn = `arn:aws:imagebuilder:${region}:${accountId}:image/alchemy-nonexistent-probe/1.0.0/1`;
    show(
      "getImage",
      yield* Effect.result(
        imagebuilder.getImage({ imageBuildVersionArn: arn }),
      ),
    );
    show(
      "deleteImage",
      yield* Effect.result(
        imagebuilder.deleteImage({ imageBuildVersionArn: arn }),
      ),
    );
    show(
      "cancelImageCreation",
      yield* Effect.result(
        imagebuilder.cancelImageCreation({
          imageBuildVersionArn: arn,
          clientToken: crypto.randomUUID(),
        }),
      ),
    );
  }),
);
