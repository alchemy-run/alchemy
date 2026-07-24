import * as AWS from "@/AWS";
import { ConfigurationSet, Tenant, TenantResourceAssociation } from "@/AWS/SES";
import * as Test from "@/Test/Alchemy";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

const associatedArns = (tenantName: string) =>
  sesv2.listTenantResources.pages({ TenantName: tenantName }).pipe(
    Stream.runCollect,
    Effect.map((pages) =>
      Array.from(pages)
        .flatMap((page) => page.TenantResources ?? [])
        .flatMap((resource) =>
          resource.ResourceArn ? [resource.ResourceArn] : [],
        ),
    ),
  );

const isAssociated = (tenantName: string, resourceArn: string) =>
  associatedArns(tenantName).pipe(
    Effect.map((arns) => arns.includes(resourceArn)),
  );

test.provider(
  "tenant resource association lifecycle: associate a config set, verify, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { tenant, configSet } = yield* stack.deploy(
        Effect.gen(function* () {
          const tenant = yield* Tenant("Customer", {});
          const configSet = yield* ConfigurationSet("Config", {});
          yield* TenantResourceAssociation("Link", {
            tenantName: tenant.tenantName,
            resourceArn: configSet.configurationSetArn,
          });
          return { tenant, configSet };
        }),
      );

      // out-of-band verification via distilled
      const found = yield* isAssociated(
        tenant.tenantName,
        configSet.configurationSetArn,
      ).pipe(
        Effect.retry({
          while: (associated) => !associated,
          schedule: Schedule.max([
            Schedule.exponential(500),
            Schedule.recurs(8),
          ]),
        }),
      );
      expect(found).toBe(true);

      yield* stack.destroy();

      // The tenant and its associations are gone after destroy; listing a
      // deleted tenant surfaces NotFoundException, treated as "not associated".
      const gone = yield* isAssociated(
        tenant.tenantName,
        configSet.configurationSetArn,
      ).pipe(Effect.catchTag("NotFoundException", () => Effect.succeed(false)));
      expect(gone).toBe(false);
    }),
  { timeout: 180_000 },
);

test.provider(
  "changing the resource ARN replaces the association",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { tenant, second } = yield* stack.deploy(
        Effect.gen(function* () {
          const tenant = yield* Tenant("Customer", {});
          const first = yield* ConfigurationSet("ConfigA", {});
          const second = yield* ConfigurationSet("ConfigB", {});
          yield* TenantResourceAssociation("Link", {
            tenantName: tenant.tenantName,
            resourceArn: first.configurationSetArn,
          });
          return { tenant, second };
        }),
      );

      // Re-point the association at the second config set. Both config sets
      // stay deployed across the replacement so the engine does not deadlock
      // removing a dependency during a replace.
      yield* stack.deploy(
        Effect.gen(function* () {
          const tenant = yield* Tenant("Customer", {});
          yield* ConfigurationSet("ConfigA", {});
          const second = yield* ConfigurationSet("ConfigB", {});
          yield* TenantResourceAssociation("Link", {
            tenantName: tenant.tenantName,
            resourceArn: second.configurationSetArn,
          });
          return tenant;
        }),
      );

      const arns = yield* associatedArns(tenant.tenantName);
      expect(arns).toContain(second.configurationSetArn);

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);
