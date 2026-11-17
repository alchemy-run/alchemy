import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ses from "@distilled.cloud/aws/sesv2";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:ses", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "SesLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const ruleSet = yield* AWS.SES.ReceiptRuleSet("lookup-target-rules");
    const tenant = yield* AWS.SES.Tenant("lookup-target-tenant");
    return {
      ruleSetName: ruleSet.ruleSetName.as<string>(),
      tenantName: tenant.tenantName.as<string>(),
      tenantArn: tenant.tenantArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "receipt rule sets and tenants resolve by name, and survive destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { ruleSetName, tenantName, tenantArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return {
            ruleSet: AWS.SES.ReceiptRuleSet.lookup({ ruleSetName }).ruleSetName,
            tenant: AWS.SES.Tenant.lookup({ tenantName }).tenantArn,
          };
        },
        {
          ruleSet: ruleSetName,
          tenant: tenantArn,
        },
      );
      const survivor = yield* ses.getTenant({ TenantName: tenantName });
      expect(survivor.Tenant?.TenantArn).toBe(tenantArn);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing rule set, tenant or IP pool fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-rule-set": AWS.SES.ReceiptRuleSet.lookup({ ruleSetName: name }).ruleSetName,
        "missing-tenant": AWS.SES.Tenant.lookup({ tenantName: name }).tenantArn,
        "missing-pool": AWS.SES.DedicatedIpPool.lookup({ poolName: name }).poolName,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(stack.deploy(AWS.SSM.Parameter(id, { value })), [
          "LookupNotFoundError",
        ]);
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a tenant this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.SES.Tenant("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-receipt-rule-set-consumer", {
              value: AWS.SES.Tenant.lookup({ tenantName: attrs.tenantName }).tenantArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
