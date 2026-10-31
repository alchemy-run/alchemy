import { partitionArn } from "@alchemy.run/aws/AWSBindings";
import { bedrockModelArns } from "@alchemy.run/aws/Bedrock/ModelArns";
import { fromCredentials } from "@alchemy.run/aws/Credentials";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { dnsSuffixOf, managedPolicyArn, partitionOf } from "@alchemy.run/aws/Partition";
import * as Region from "@alchemy.run/aws/Region";
import { describe, expect, it } from "@alchemy.run/test";
import * as iam from "@distilled.cloud/aws/iam";
import * as lambda from "@distilled.cloud/aws/lambda";
import * as s3 from "@distilled.cloud/aws/s3";
import * as sts from "@distilled.cloud/aws/sts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Output from "alchemy/Output";
import { inMemoryState } from "alchemy/State/InMemoryState";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

const tags = { tags: ["unit", "provider:aws", "local"] };

const sovereign = [
  { region: "eusc-de-east-1", partition: "aws-eusc", dnsSuffix: "amazonaws.eu" },
  { region: "cn-north-1", partition: "aws-cn", dnsSuffix: "amazonaws.com.cn" },
  { region: "us-gov-west-1", partition: "aws-us-gov", dnsSuffix: "amazonaws.com" },
] as const;

const environment = (region: string) =>
  Layer.succeed(
    AWSEnvironment,
    Effect.succeed({
      accountId: "123456789012",
      region,
      credentials: Effect.die("no credentials in a unit test"),
    }),
  );

describe("partitionOf", tags, () => {
  for (const { region, partition, dnsSuffix } of sovereign) {
    it(`puts ${region} in ${partition} with endpoint suffix ${dnsSuffix}`, () => {
      expect(partitionOf(region)).toBe(partition);
      expect(dnsSuffixOf(region)).toBe(dnsSuffix);
    });
  }

  it("keeps commercial and unknown regions in aws", () => {
    expect(partitionOf("us-east-1")).toBe("aws");
    expect(partitionOf("eu-central-1")).toBe("aws");
    expect(partitionOf("not-a-region")).toBe("aws");
    expect(dnsSuffixOf("eu-central-1")).toBe("amazonaws.com");
  });

  // distilled resolves endpoints from its copy of botocore's partitions.json;
  // ARNs must land in the same partition its endpoints do.
  it.effect("agrees with every region in distilled's partitions.json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.resolve(
        import.meta.dirname,
        "../../../../submodules/distilled/packages/aws/src/rules-engine/partitions.json",
      );
      const { partitions } = JSON.parse(yield* fs.readFileString(file)) as {
        partitions: { id: string; outputs: { dnsSuffix: string }; regions: object }[];
      };
      const regions = partitions.flatMap(({ id, outputs, regions }) =>
        Object.keys(regions)
          .filter((region) => !region.endsWith("-global"))
          .map((region) => ({ region, id, dnsSuffix: outputs.dnsSuffix })),
      );
      expect(regions.some(({ id }) => id === "aws-eusc")).toBe(true);
      for (const { region, id, dnsSuffix } of regions) {
        expect({ region, partition: partitionOf(region), dnsSuffix: dnsSuffixOf(region) }).toEqual({
          region,
          partition: id,
          dnsSuffix,
        });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("AWSEnvironment.current", tags, () => {
  it.effect("derives the partition from the region", () =>
    Effect.gen(function* () {
      const { partition } = yield* AWSEnvironment.current;
      expect(partition).toBe("aws-eusc");
    }).pipe(Effect.provide(environment("eusc-de-east-1"))),
  );

  it.effect("follows a region overridden on a provided environment", () =>
    Effect.gen(function* () {
      const { partition, region } = yield* AWSEnvironment.current;
      expect({ partition, region }).toEqual({ partition: "aws-cn", region: "cn-north-1" });
    }).pipe(
      Effect.provide(
        Layer.effect(
          AWSEnvironment,
          Effect.gen(function* () {
            const base = yield* AWSEnvironment;
            return Effect.map(base, (env) => ({ ...env, region: "cn-north-1" }));
          }),
        ).pipe(Layer.provide(environment("us-east-1"))),
      ),
    ),
  );
});

describe("ARNs", tags, () => {
  for (const { region, partition } of sovereign) {
    it(`builds Bedrock model ARNs in ${partition}`, () => {
      expect(bedrockModelArns(region, "123456789012", "eu.amazon.nova-micro-v1:0")).toEqual([
        `arn:${partition}:bedrock:${region}:123456789012:inference-profile/eu.amazon.nova-micro-v1:0`,
        `arn:${partition}:bedrock:*::foundation-model/amazon.nova-micro-v1:0`,
      ]);
      expect(bedrockModelArns(region, "123456789012", "amazon.nova-micro-v1:0")).toEqual([
        `arn:${partition}:bedrock:${region}::foundation-model/amazon.nova-micro-v1:0`,
      ]);
    });

    it.effect(`resolves a binding's region-less ARN in ${partition}`, () =>
      Effect.gen(function* () {
        expect(yield* Output.evaluate(partitionArn("ec2:*::snapshot/*"), {})).toBe(
          `arn:${partition}:ec2:*::snapshot/*`,
        );
      }).pipe(Effect.provide(Layer.mergeAll(environment(region), inMemoryState()))),
    );
  }

  it("names AWS managed policies in the partition", () => {
    expect(managedPolicyArn("aws", "service-role/AWSLambdaBasicExecutionRole")).toBe(
      "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    );
    expect(managedPolicyArn("aws-eusc", "service-role/AWSLambdaBasicExecutionRole")).toBe(
      "arn:aws-eusc:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    );
  });
});

/** The host each SDK call is sent to in `region`, captured before any network I/O. */
const hostOf = (region: string, call: Effect.Effect<unknown, unknown, any>) =>
  Effect.gen(function* () {
    let host: string | undefined;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        host = new URL(request.url).host;
        return HttpClientResponse.fromWeb(request, new Response("", { status: 400 }));
      }),
    );
    yield* call.pipe(
      Effect.provide(
        Layer.mergeAll(
          Region.of(region),
          fromCredentials(
            {
              accessKeyId: Redacted.make("AKIDEXAMPLE"),
              secretAccessKey: Redacted.make("secret"),
            },
            region,
          ),
          Layer.succeed(HttpClient.HttpClient, http),
        ),
      ),
      Effect.exit,
    );
    return host;
  });

describe("SDK endpoints", tags, () => {
  const expected = {
    "eusc-de-east-1": {
      sts: "sts.eusc-de-east-1.amazonaws.eu",
      s3: "s3.eusc-de-east-1.amazonaws.eu",
      lambda: "lambda.eusc-de-east-1.amazonaws.eu",
      iam: "iam.eusc-de-east-1.amazonaws.eu",
    },
    "cn-north-1": {
      sts: "sts.cn-north-1.amazonaws.com.cn",
      s3: "s3.cn-north-1.amazonaws.com.cn",
      lambda: "lambda.cn-north-1.amazonaws.com.cn",
      iam: "iam.cn-north-1.amazonaws.com.cn",
    },
    "us-gov-west-1": {
      sts: "sts.us-gov-west-1.amazonaws.com",
      s3: "s3.us-gov-west-1.amazonaws.com",
      lambda: "lambda.us-gov-west-1.amazonaws.com",
      iam: "iam.us-gov.amazonaws.com",
    },
  } as const;

  for (const [region, hosts] of Object.entries(expected)) {
    it.effect(`sends calls in ${region} to its partition's endpoints`, () =>
      Effect.gen(function* () {
        expect({
          sts: yield* hostOf(region, sts.getCallerIdentity({})),
          s3: yield* hostOf(region, s3.listBuckets({})),
          lambda: yield* hostOf(region, lambda.listFunctions({})),
          iam: yield* hostOf(region, iam.listRoles({})),
        }).toEqual(hosts);
      }),
    );
  }
});
