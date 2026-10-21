import * as AWS from "@alchemy.run/aws";
import { isNukeableHealthCheck } from "@alchemy.run/aws/Route53/HealthCheck";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

test(
  "nuke inventory excludes AWS-service-owned health checks",
  Effect.sync(() => {
    expect(isNukeableHealthCheck({})).toBe(true);
    expect(
      isNukeableHealthCheck({
        LinkedService: {
          ServicePrincipal: "servicediscovery.amazonaws.com",
          Description: "Cloud Map managed health check",
        },
      }),
    ).toBe(false);
    expect(isNukeableHealthCheck({ LinkedService: {} })).toBe(false);
  }),
  { tags: ["provider:aws", "provider:aws:route53", "live"] },
);
