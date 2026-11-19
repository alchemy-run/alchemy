import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as organizations from "@distilled.cloud/daytona/organizations";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Daytona.providers() });

// Daytona resolves the endpoint's hostname, so these must be real hosts. It
// stores them normalized, with a trailing slash.
const HONEYCOMB = "https://api.honeycomb.io/";
const NEW_RELIC = "https://otlp.nr-data.net/";

const otelConfig = (organizationId: string) =>
  Effect.map(organizations.getOrganization({ organizationId }), (o) => o.otelConfig);

test.provider(
  "export telemetry to an OTLP endpoint, change it, stop it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (endpoint?: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const organization = yield* Daytona.Organization("Team", { defaultRegionId: "us" });
            const telemetry = endpoint
              ? yield* Daytona.OrganizationOtelConfig("Telemetry", {
                  organization,
                  endpoint,
                  headers: { "x-honeycomb-team": Redacted.make("not-a-key") },
                })
              : undefined;
            return { organization, telemetry };
          }),
        );

      const first = yield* deploy(HONEYCOMB);
      expect(first.telemetry?.headerNames).toEqual(["x-honeycomb-team"]);
      const organizationId = first.organization.organizationId;
      expect((yield* otelConfig(organizationId))?.endpoint).toEqual(HONEYCOMB);

      yield* deploy(NEW_RELIC);
      expect((yield* otelConfig(organizationId))?.endpoint).toEqual(NEW_RELIC);

      // Removing the resource stops the export.
      yield* deploy();
      expect((yield* otelConfig(organizationId))?.endpoint).toBeUndefined();

      yield* stack.destroy();
    }),
  { tags: ["provider:daytona", "live"], timeout: 120_000 },
);
