import * as AWS from "@/AWS";
import { UserPool } from "@/AWS/Cognito";
import { WebACL, WebACLAssociation } from "@/AWS/WAFv2";
import * as Test from "@/Test/Vitest";
import * as wafv2 from "@distilled.cloud/aws/wafv2";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class WebACLStillExists extends Data.TaggedError("WebACLStillExists")<{
  readonly name: string;
}> {}

class AssociationPending extends Data.TaggedError("AssociationPending")<{
  readonly resourceArn: string;
  readonly expected: string | undefined;
  readonly actual: string | undefined;
}> {}

const assertWebAclDeleted = (name: string, id: string) =>
  wafv2.getWebACL({ Name: name, Scope: "REGIONAL", Id: id }).pipe(
    Effect.flatMap(() => Effect.fail(new WebACLStillExists({ name }))),
    Effect.catchTag("WAFNonexistentItemException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "WebACLStillExists",
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(8)),
      ),
    }),
  );

// Association reads are eventually consistent — poll until the observed web
// ACL matches the expectation (bounded).
const assertAssociated = (resourceArn: string, expected: string | undefined) =>
  wafv2.getWebACLForResource({ ResourceArn: resourceArn }).pipe(
    Effect.flatMap((response) =>
      response.WebACL?.ARN === expected
        ? Effect.void
        : Effect.fail(
            new AssociationPending({
              resourceArn,
              expected,
              actual: response.WebACL?.ARN,
            }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "AssociationPending",
      schedule: Schedule.fixed("2 seconds").pipe(
        Schedule.both(Schedule.recurs(15)),
      ),
    }),
  );

test.provider(
  "associate a web ACL with a Cognito user pool, re-point, disassociate",
  (stack) =>
    Effect.gen(function* () {
      // create pool + ACL + association in one deploy
      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("WafProtectedPool", {});
          const acl = yield* WebACL("PoolAclA", {});
          yield* WebACLAssociation("PoolAssociation", {
            webAclArn: acl.webAclArn,
            resourceArn: pool.userPoolArn,
          });
          return {
            poolArn: pool.userPoolArn,
            aclName: acl.webAclName,
            aclId: acl.webAclId,
            aclArn: acl.webAclArn,
          };
        }),
      );

      // out-of-band verification via getWebACLForResource
      yield* assertAssociated(outputs.poolArn, outputs.aclArn);

      // re-point the association at a second web ACL in place (keep the
      // first ACL deployed — never drop a dependency in the same step)
      const repointed = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("WafProtectedPool", {});
          yield* WebACL("PoolAclA", {});
          const aclB = yield* WebACL("PoolAclB", {});
          yield* WebACLAssociation("PoolAssociation", {
            webAclArn: aclB.webAclArn,
            resourceArn: pool.userPoolArn,
          });
          return {
            aclBName: aclB.webAclName,
            aclBId: aclB.webAclId,
            aclBArn: aclB.webAclArn,
          };
        }),
      );

      expect(repointed.aclBArn).not.toBe(outputs.aclArn);
      yield* assertAssociated(outputs.poolArn, repointed.aclBArn);

      // destroy everything; deletion order proves the association was
      // removed before its web ACL (deleteWebACL fails while associated)
      yield* stack.destroy();
      yield* assertWebAclDeleted(outputs.aclName, outputs.aclId);
      yield* assertWebAclDeleted(repointed.aclBName, repointed.aclBId);
    }),
  { timeout: 180_000 },
);
