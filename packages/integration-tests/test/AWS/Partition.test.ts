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
import * as Output from "alchemy/Output";
import { inMemoryState } from "alchemy/State/InMemoryState";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

  it("names every partition in distilled's partitions.json", () => {
    expect(
      Object.fromEntries(
        [
          "us-east-1",
          "us-gov-west-1",
          "cn-northwest-1",
          "us-iso-east-1",
          "us-isob-east-1",
          "eu-isoe-west-1",
          "us-isof-south-1",
          "eusc-de-east-1",
        ].map((region) => [region, [partitionOf(region), globalRegionOf(region)]]),
      ),
    ).toEqual({
      "us-east-1": ["aws", "us-east-1"],
      "us-gov-west-1": ["aws-us-gov", "us-gov-west-1"],
      "cn-northwest-1": ["aws-cn", "cn-northwest-1"],
      "us-iso-east-1": ["aws-iso", "us-iso-east-1"],
      "us-isob-east-1": ["aws-iso-b", "us-isob-east-1"],
      "eu-isoe-west-1": ["aws-iso-e", "eu-isoe-west-1"],
      "us-isof-south-1": ["aws-iso-f", "us-isof-south-1"],
      "eusc-de-east-1": ["aws-eusc", "eusc-de-east-1"],
    });
  });
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
 * The region `pin` runs a call in, from a stack in `region`.
 * `provideRegion: false` leaves only the credentials' region, as for a stack
 * that never provides a `Region`.
 */
const regionUnder = (
  region: string,
  pin: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | Region.Region>,
  { provideRegion = true }: { provideRegion?: boolean } = {},
) => {
  const pinned = pin(Effect.flatMap(Effect.service(Region.Region), (current) => current)).pipe(
    Effect.provide(
      fromCredentials(
        { accessKeyId: Redacted.make("AKIDEXAMPLE"), secretAccessKey: Redacted.make("secret") },
        region,
      ),
    ),
  );
  // Without a provided Region, the pin derives one from the credentials, which
  // its type does not express.
  return provideRegion
    ? pinned.pipe(Effect.provide(Region.of(region)))
    : (pinned as Effect.Effect<string, unknown>);
};

describe("withGlobalRegion", tags, () => {
  const expected = {
    "eu-central-1": "us-east-1",
    "us-gov-east-1": "us-gov-west-1",
    "eusc-de-east-1": "eusc-de-east-1",
    "cn-north-1": "cn-northwest-1",
  } as const;

  for (const [region, globalRegion] of Object.entries(expected)) {
    it.effect(`runs global services from ${region} in ${globalRegion}`, () =>
      Effect.gen(function* () {
        expect(yield* regionUnder(region, Region.withGlobalRegion)).toBe(globalRegion);
        expect(yield* regionUnder(region, Region.withGlobalRegion, { provideRegion: false })).toBe(
          globalRegion,
        );
      }),
    );
  }
});

describe("CloudFront-only and regional-only pins", tags, () => {
  const expected = {
    "eu-central-1": { wafCloudFront: "us-east-1", kvs: "us-east-1", fleetWise: "eu-central-1" },
    "us-west-2": { wafCloudFront: "us-east-1", kvs: "us-east-1", fleetWise: "us-east-1" },
    "eusc-de-east-1": {
      wafCloudFront: "eusc-de-east-1",
      kvs: "eusc-de-east-1",
      fleetWise: "eusc-de-east-1",
    },
    "cn-north-1": {
      wafCloudFront: "cn-northwest-1",
      kvs: "cn-northwest-1",
      fleetWise: "cn-north-1",
    },
  } as const;

  for (const [region, want] of Object.entries(expected)) {
    it.effect(`keeps ${region}'s calls in its partition`, () =>
      Effect.gen(function* () {
        expect({
          wafCloudFront: yield* regionUnder(region, (effect) => withWafScope("CLOUDFRONT", effect)),
          kvs: yield* regionUnder(region, withKvsRegion),
          fleetWise: yield* regionUnder(region, inFleetWiseRegion),
        }).toEqual(want);
        // REGIONAL scope follows the ambient region in every partition.
        expect(yield* regionUnder(region, (effect) => withWafScope("REGIONAL", effect))).toBe(
          region,
        );
      }),
    );
  }
});
