import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:cloudfront", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "CloudFrontLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const store = yield* AWS.CloudFront.KeyValueStore("lookup-target-kvs");
    const fn = yield* AWS.CloudFront.Function("lookup-target-fn", {
      code: "async function handler(event) { return event.request; }",
    });
    const cache = yield* AWS.CloudFront.CachePolicy("lookup-target-cache", { minTTL: 0 });
    const origin = yield* AWS.CloudFront.OriginRequestPolicy("lookup-target-origin", {
      headersConfig: { HeaderBehavior: "none" },
      cookiesConfig: { CookieBehavior: "none" },
      queryStringsConfig: { QueryStringBehavior: "none" },
    });
    const headers = yield* AWS.CloudFront.ResponseHeadersPolicy("lookup-target-headers", {
      comment: "lookup target",
      serverTimingHeadersConfig: { Enabled: true, SamplingRate: 0 },
    });
    const oac = yield* AWS.CloudFront.OriginAccessControl("lookup-target-oac");
    return {
      kvsName: store.keyValueStoreName.as<string>(),
      kvsArn: store.keyValueStoreArn.as<string>(),
      fnName: fn.functionName.as<string>(),
      fnArn: fn.functionArn.as<string>(),
      cachePolicyId: cache.cachePolicyId.as<string>(),
      cacheName: cache.name.as<string>(),
      originRequestPolicyId: origin.originRequestPolicyId.as<string>(),
      originName: origin.name.as<string>(),
      responseHeadersPolicyId: headers.responseHeadersPolicyId.as<string>(),
      headersName: headers.name.as<string>(),
      originAccessControlId: oac.originAccessControlId.as<string>(),
      oacName: oac.name.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "key value stores, functions, policies and origin access controls resolve by id and name, and survive destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const {
        kvsName,
        kvsArn,
        fnName,
        fnArn,
        cachePolicyId,
        cacheName,
        originRequestPolicyId,
        originName,
        responseHeadersPolicyId,
        headersName,
        originAccessControlId,
        oacName,
      } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return {
            kvs: AWS.CloudFront.KeyValueStore.lookup({ keyValueStoreName: kvsName })
              .keyValueStoreArn,
            fn: AWS.CloudFront.Function.lookup({ functionName: fnName }).functionArn,
            cacheByName: AWS.CloudFront.CachePolicy.lookup({ name: cacheName }).cachePolicyId,
            cacheById: AWS.CloudFront.CachePolicy.lookup({ cachePolicyId }).name,
            originByName: AWS.CloudFront.OriginRequestPolicy.lookup({ name: originName })
              .originRequestPolicyId,
            headersByName: AWS.CloudFront.ResponseHeadersPolicy.lookup({ name: headersName })
              .responseHeadersPolicyId,
            oacByName: AWS.CloudFront.OriginAccessControl.lookup({ name: oacName })
              .originAccessControlId,
            oacById: AWS.CloudFront.OriginAccessControl.lookup({ originAccessControlId }).name,
          };
        },
        {
          kvs: kvsArn,
          fn: fnArn,
          cacheByName: cachePolicyId,
          cacheById: cacheName,
          originByName: originRequestPolicyId,
          headersByName: responseHeadersPolicyId,
          oacByName: originAccessControlId,
          oacById: oacName,
        },
      );
      const survivor = yield* cloudfront.getCachePolicy({ Id: cachePolicyId });
      expect(survivor.CachePolicy?.CachePolicyConfig?.Name).toBe(cacheName);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "AWS managed policies resolve by name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const {
        kvsName,
        kvsArn,
        fnName,
        fnArn,
        cachePolicyId,
        cacheName,
        originRequestPolicyId,
        originName,
        responseHeadersPolicyId,
        headersName,
        originAccessControlId,
        oacName,
      } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return {
            caching: AWS.CloudFront.CachePolicy.lookup({ name: "Managed-CachingOptimized" })
              .cachePolicyId,
            viewer: AWS.CloudFront.OriginRequestPolicy.lookup({ name: "Managed-AllViewer" })
              .originRequestPolicyId,
            security: AWS.CloudFront.ResponseHeadersPolicy.lookup({
              name: "Managed-SecurityHeadersPolicy",
            }).responseHeadersPolicyId,
          };
        },
        {
          caching: "658327ea-f89d-4fab-a63d-7e88639e58f6",
          viewer: "216adef6-5c7f-47e4-b989-5492eafa07d3",
          security: "67f7725c-6f97-4210-82d7-5512b31e9d03",
        },
      );
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing cache policy fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-cache-policy", {
            value: AWS.CloudFront.CachePolicy.lookup({ name }).cachePolicyId,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a cache policy this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.CloudFront.CachePolicy("lookup-managed", { minTTL: 0 });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-cache-policy-consumer", {
              value: AWS.CloudFront.CachePolicy.lookup({ cachePolicyId: attrs.cachePolicyId })
                .cachePolicyId,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
