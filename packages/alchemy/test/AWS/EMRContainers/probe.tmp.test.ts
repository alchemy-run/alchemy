import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as emrc from "@distilled.cloud/aws/emr-containers";
import * as sts from "@distilled.cloud/aws/sts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

test.provider("probe: tagResource arn variants", () =>
  Effect.gen(function* () {
    const identity = yield* sts.getCallerIdentity({});
    const token = crypto.randomUUID().replaceAll("-", "");
    const created = yield* emrc.createJobTemplate({
      clientToken: token,
      name: "alchemy-probe-tag",
      jobTemplateData: {
        executionRoleArn: `arn:aws:iam::${identity.Account}:role/alchemy-probe`,
        releaseLabel: "emr-7.5.0-latest",
        jobDriver: {
          sparkSubmitJobDriver: { entryPoint: "s3://bucket/script.py" },
        },
      },
      tags: { Origin: "alchemy-probe" },
    });

    const arn = created.arn!;
    const variants: Record<string, string> = {
      raw: arn,
      noSlash: arn.replace(":/jobtemplates/", ":jobtemplates/"),
    };
    const results: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(variants)) {
      const r = yield* Effect.result(
        emrc.tagResource({ resourceArn: value, tags: { Extra: "1" } }),
      );
      results[name] = Result.isFailure(r)
        ? ((r.failure as { message?: string }).message ?? r.failure)
        : "OK";
    }
    const untagR = yield* Effect.result(
      emrc.untagResource({ resourceArn: arn, tagKeys: ["Origin"] }),
    );
    results.untagRaw = Result.isFailure(untagR)
      ? ((untagR.failure as { message?: string }).message ?? untagR.failure)
      : "OK";

    yield* emrc
      .deleteJobTemplate({ id: created.id! })
      .pipe(Effect.catch(() => Effect.void));

    throw new Error(`RESULTS ${JSON.stringify(results)}`);
  }),
);
