import { partitionArn } from "@alchemy.run/aws/AWSBindings";
import { bedrockModelArns } from "@alchemy.run/aws/Bedrock/ModelArns";
import { withKvsRegion } from "@alchemy.run/aws/CloudFront/common";
import { fromCredentials } from "@alchemy.run/aws/Credentials";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { inFleetWiseRegion } from "@alchemy.run/aws/IoTFleetWise/internal";
import {
  dnsSuffixOf,
  globalRegionOf,
  managedPolicyArn,
  partitionOf,
} from "@alchemy.run/aws/Partition";
import * as Region from "@alchemy.run/aws/Region";
import { withWafScope } from "@alchemy.run/aws/WAFv2/internal";
import { describe, expect, it } from "@alchemy.run/test";
import * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import * as costExplorer from "@distilled.cloud/aws/cost-explorer";
import * as iam from "@distilled.cloud/aws/iam";
import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import * as lambda from "@distilled.cloud/aws/lambda";
import * as route53domains from "@distilled.cloud/aws/route-53-domains";
import * as s3 from "@distilled.cloud/aws/s3";
import * as sts from "@distilled.cloud/aws/sts";
import * as wafv2 from "@distilled.cloud/aws/wafv2";
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
        partitions: {
          id: string;
          outputs: { dnsSuffix: string; implicitGlobalRegion: string };
          regions: object;
        }[];
      };
      const regions = partitions.flatMap(({ id, outputs, regions }) =>
        Object.keys(regions)
          .filter((region) => !region.endsWith("-global"))
          .map((region) => ({
            region,
            partition: id,
            dnsSuffix: outputs.dnsSuffix,
            globalRegion: outputs.implicitGlobalRegion,
          })),
      );
      expect(regions.some(({ partition }) => partition === "aws-eusc")).toBe(true);
      for (const expected of regions) {
        const { region } = expected;
        expect({
          region,
          partition: partitionOf(region),
          dnsSuffix: dnsSuffixOf(region),
          globalRegion: globalRegionOf(region),
        }).toEqual(expected);
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

/**
 * The request an SDK call sends in `region`, captured before any network
 * I/O: its host and SigV4 credential scope (`{region}/{service}`, or just
 * `{service}` under SigV4a), or the error when it sends nothing.
 * `provideRegion: false` leaves only the credentials' region, as for a stack
 * that never provides a `Region`.
 */
const requestOf = (
  region: string,
  call: Effect.Effect<unknown, unknown, any>,
  { provideRegion = true }: { provideRegion?: boolean } = {},
) =>
  Effect.gen(function* () {
    let sent: { host: string; scope: string | undefined } | undefined;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        sent = {
          host: new URL(request.url).host,
          scope: /Credential=[^/]+\/\d{8}\/(.+)\/aws4_request/.exec(
            request.headers.authorization ?? "",
          )?.[1],
        };
        return HttpClientResponse.fromWeb(request, new Response("", { status: 400 }));
      }),
    );
    const error = yield* call.pipe(
      Effect.provide(
        Layer.mergeAll(
          provideRegion ? Region.of(region) : Layer.empty,
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
      Effect.flip,
      Effect.map((error) => (error as { message?: string }).message),
      Effect.orElseSucceed(() => undefined),
    );
    return sent ?? { error };
  });

/** The host an SDK call is sent to in `region` (see {@link requestOf}). */
const hostOf = (
  region: string,
  call: Effect.Effect<unknown, unknown, any>,
  options?: { provideRegion?: boolean },
) =>
  Effect.map(requestOf(region, call, options), (request) =>
    "host" in request ? request.host : undefined,
  );

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

describe("withGlobalRegion", tags, () => {
  const expected = {
    "eu-central-1": {
      route53domains: "route53domains.us-east-1.amazonaws.com",
      costExplorer: "ce.us-east-1.amazonaws.com",
    },
    "eusc-de-east-1": {
      route53domains: "route53domains.eusc-de-east-1.amazonaws.eu",
      costExplorer: "ce.eusc-de-east-1.api.amazonwebservices.eu",
    },
    "cn-north-1": {
      route53domains: "route53domains.cn-northwest-1.amazonaws.com.cn",
      costExplorer: "ce.cn-northwest-1.amazonaws.com.cn",
    },
  } as const;

  for (const [region, hosts] of Object.entries(expected)) {
    it.effect(`keeps global services in ${region}'s partition`, () =>
      Effect.gen(function* () {
        const calls = {
          route53domains: Region.withGlobalRegion(route53domains.listDomains({})),
          costExplorer: Region.withGlobalRegion(costExplorer.listCostAllocationTags({})),
        };
        expect({
          route53domains: yield* hostOf(region, calls.route53domains),
          costExplorer: yield* hostOf(region, calls.costExplorer),
        }).toEqual(hosts);
        expect({
          route53domains: yield* hostOf(region, calls.route53domains, { provideRegion: false }),
          costExplorer: yield* hostOf(region, calls.costExplorer, { provideRegion: false }),
        }).toEqual(hosts);
      }),
    );
  }
});

describe("CloudFront-only and regional-only pins", tags, () => {
  const kvsArn = (region: string) =>
    `arn:${partitionOf(region)}:cloudfront::111111111111:key-value-store/0123456789abcdef`;
  // KeyValueStore is signed with SigV4a in `aws` and rejected by its endpoint
  // rules, before any request, in partitions without CloudFront.
  const kvsHost = {
    host: "111111111111.cloudfront-kvs.global.api.aws",
    scope: "cloudfront-keyvaluestore",
  };
  const kvsUnsupported = (partition: string) => ({
    error: `CloudFront-KeyValueStore is not supported in partition \`${partition}\``,
  });
  const expected = {
    "eu-central-1": {
      wafCloudFront: "wafv2.us-east-1.amazonaws.com",
      kvs: kvsHost,
      fleetWise: "iotfleetwise.eu-central-1.amazonaws.com",
    },
    "us-west-2": {
      wafCloudFront: "wafv2.us-east-1.amazonaws.com",
      kvs: kvsHost,
      fleetWise: "iotfleetwise.us-east-1.amazonaws.com",
    },
    "eusc-de-east-1": {
      wafCloudFront: "wafv2.eusc-de-east-1.amazonaws.eu",
      kvs: kvsUnsupported("aws-eusc"),
      fleetWise: "iotfleetwise.eusc-de-east-1.amazonaws.eu",
    },
    "cn-north-1": {
      wafCloudFront: "wafv2.cn-northwest-1.amazonaws.com.cn",
      kvs: kvsUnsupported("aws-cn"),
      fleetWise: "iotfleetwise.cn-north-1.amazonaws.com.cn",
    },
  } as const;

  for (const [region, want] of Object.entries(expected)) {
    it.effect(`keeps ${region}'s calls in its partition`, () =>
      Effect.gen(function* () {
        expect({
          wafCloudFront: yield* hostOf(
            region,
            withWafScope("CLOUDFRONT", wafv2.listWebACLs({ Scope: "CLOUDFRONT" })),
          ),
          kvs: yield* requestOf(
            region,
            withKvsRegion(kvs.describeKeyValueStore({ KvsARN: kvsArn(region) })),
          ),
          fleetWise: yield* hostOf(region, inFleetWiseRegion(iotfleetwise.listFleets({}))),
        }).toEqual(want);
        // REGIONAL scope follows the ambient region in every partition.
        expect(
          yield* hostOf(region, withWafScope("REGIONAL", wafv2.listWebACLs({ Scope: "REGIONAL" }))),
        ).toBe(`wafv2.${region}.${dnsSuffixOf(region)}`);
      }),
    );
  }
});
