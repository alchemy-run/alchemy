import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as acm from "@distilled.cloud/aws/acm";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { testName } from "../../names.ts";
import { expectLookupConsumers } from "../lookup.ts";

// ACM certificates are provider-pinned to us-east-1, so out-of-band calls
// run there too.
const inAcmRegion = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed("us-east-1")));

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:acm", "live"];

// A requested certificate stays pending validation, so only the lookup by
// ARN finds it; a lookup by domain matches issued certificates only.

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "CertificateLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const certificate = yield* AWS.ACM.Certificate("lookup-target", {
      domainName: `${testName("alchemy-lookup")}.example.com`,
    });
    return {
      certificateArn: certificate.certificateArn.as<string>(),
      domainName: certificate.domainName.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up certificate resolves by ARN, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { certificateArn, domainName } = yield* target;
      // ACM fills in a just-requested certificate's domain a moment later.
      yield* inAcmRegion(acm.describeCertificate({ CertificateArn: certificateArn })).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (r) => r.Certificate?.DomainName !== undefined,
          times: 15,
        }),
      );
      yield* expectLookupConsumers(
        stack,
        () => {
          const certificate = AWS.ACM.Certificate.lookup({ certificateArn });
          return { domain: certificate.domainName };
        },
        {
          domain: domainName,
        },
      );
      const survivor = yield* inAcmRegion(
        acm.describeCertificate({ CertificateArn: certificateArn }),
      );
      expect(survivor.Certificate?.DomainName).toBe(domainName);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing certificate fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-certificate", {
            value: AWS.ACM.Certificate.lookup({ domainName: `${name}.example.com` }).certificateArn,
          }),
        ),
        ["LookupNotFoundError"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a certificate this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        AWS.ACM.Certificate("lookup-managed", {
          domainName: `${testName("alchemy-lookup-managed")}.example.com`,
        });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-certificate-consumer", {
              value: AWS.ACM.Certificate.lookup({ certificateArn: attrs.certificateArn })
                .certificateArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
