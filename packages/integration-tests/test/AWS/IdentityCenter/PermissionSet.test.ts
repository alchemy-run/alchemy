import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { PermissionSet } from "@alchemy.run/aws/IdentityCenter";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import { adopt } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: AWS.providers() });

// Requires an enabled IAM Identity Center (SSO) instance in the testing
// account. Without one, `resolveInstance` fails with:
//   Error: "Unable to resolve a single visible Identity Center instance;
//           pass instanceArn explicitly"
// The testing account is an ORGANIZATION MANAGEMENT account, where
// `CreateInstance` is rejected with a typed
//   ValidationException: "Organization management account is not allowed to
//                         perform the operation."
// and organization instances can only be enabled via the console — so an
// instance cannot be provisioned programmatically. Gate the live lifecycle
// behind ALCHEMY_TEST_IDENTITY_CENTER=1 so an entitled account runs it
// unchanged.
const SKIP_IDENTITY_CENTER = !process.env.ALCHEMY_TEST_IDENTITY_CENTER;

const inlineDocument = (action: string) => ({
  Version: "2012-10-17" as const,
  Statement: [
    {
      Sid: "ReadDevelopmentSecrets",
      Effect: "Allow" as const,
      Action: [action],
      Resource: ["arn:aws:s3:::alchemy-policy-test/*"],
      Condition: { StringEquals: { "aws:PrincipalTag/__proto__": "engineering" } },
    },
  ],
});

describe(
  "PermissionSetInlinePolicy resource",
  { tags: ["live", "provider:aws", "provider:aws:identitycenter"] },
  () => {
    test.provider.skipIf(SKIP_IDENTITY_CENTER)(
      "updates, moves unresolved targets, reprovisions and tolerates absent policies",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { accountId } = yield* AWSEnvironment.current;
          const base = PermissionSet("First", {
            name: `inline-first-${stack.stage}`,
            description: "Preserve this description",
            sessionDuration: "2 hours",
          });
          const first = yield* stack.deploy(base);
          yield* ssoAdmin.provisionPermissionSet({
            InstanceArn: first.instanceArn,
            PermissionSetArn: first.permissionSetArn,
            TargetType: "AWS_ACCOUNT",
            TargetId: accountId,
          });
          const resources = (move: boolean, action: string, raw: boolean, replaceSet = false) =>
            Effect.gen(function* () {
              const first = yield* base;
              const target = move
                ? yield* PermissionSet("Second", {
                    name: `second-${replaceSet ? "new-" : ""}${stack.stage}`,
                  })
                : first;
              const policy = yield* AWS.IdentityCenter.PermissionSetInlinePolicy("Policy", {
                permissionSetArn: target.permissionSetArn,
                policyDocument: raw
                  ? JSON.stringify(inlineDocument(action))
                  : inlineDocument(action),
              });
              const observer = yield* AWS.IdentityCenter.Group("Observer", {
                displayName: policy.permissionSetArn,
                description: policy.policyDocument,
              });
              return { policy, observer };
            });
          const created = yield* stack.deploy(resources(false, "s3:GetObject", false));
          const wire = yield* ssoAdmin.getInlinePolicyForPermissionSet({
            InstanceArn: first.instanceArn,
            PermissionSetArn: first.permissionSetArn,
          });
          expect(JSON.parse(wire.InlinePolicy!)).toEqual(inlineDocument("s3:GetObject"));
          expect(
            (yield* ssoAdmin.listAccountsForProvisionedPermissionSet({
              InstanceArn: first.instanceArn,
              PermissionSetArn: first.permissionSetArn,
              ProvisioningStatus: "LATEST_PERMISSION_SET_NOT_PROVISIONED",
            })).AccountIds,
          ).toEqual([]);
          expect(
            (yield* ssoAdmin.listAccountsForProvisionedPermissionSet({
              InstanceArn: first.instanceArn,
              PermissionSetArn: first.permissionSetArn,
              ProvisioningStatus: "LATEST_PERMISSION_SET_PROVISIONED",
            })).AccountIds,
          ).toEqual([accountId]);
          const unchanged = yield* ssoAdmin.describePermissionSet({
            InstanceArn: first.instanceArn,
            PermissionSetArn: first.permissionSetArn,
          });
          expect(unchanged.PermissionSet).toMatchObject({
            Description: "Preserve this description",
            SessionDuration: "PT2H",
          });

          const updated = yield* stack.deploy(resources(false, "s3:PutObject", true));
          expect(JSON.parse(updated.policy.policyDocument).Statement.Action).toBe("s3:PutObject");
          // Simulate the service state left by a put whose provisioning was interrupted.
          yield* ssoAdmin.putInlinePolicyToPermissionSet({
            InstanceArn: first.instanceArn,
            PermissionSetArn: first.permissionSetArn,
            InlinePolicy: JSON.stringify(inlineDocument("s3:PutObject")),
          });
          expect(
            (yield* ssoAdmin.listAccountsForProvisionedPermissionSet({
              InstanceArn: first.instanceArn,
              PermissionSetArn: first.permissionSetArn,
              ProvisioningStatus: "LATEST_PERMISSION_SET_NOT_PROVISIONED",
            })).AccountIds,
          ).toEqual([accountId]);
          // Same document, different input representation forces an update without a put.
          yield* stack.deploy(resources(false, "s3:PutObject", false));
          expect(
            (yield* ssoAdmin.listAccountsForProvisionedPermissionSet({
              InstanceArn: first.instanceArn,
              PermissionSetArn: first.permissionSetArn,
              ProvisioningStatus: "LATEST_PERMISSION_SET_NOT_PROVISIONED",
            })).AccountIds,
          ).toEqual([]);

          const plan = yield* stack.plan(resources(true, "s3:DeleteObject", true));
          expect(plan.resources.Policy?.action).toBe("update");
          expect(plan.resources.Observer?.action).toBe("update");
          const moved = yield* stack.deploy(resources(true, "s3:DeleteObject", true));
          expect(moved.policy.permissionSetArn).not.toBe(created.policy.permissionSetArn);
          expect(
            (yield* ssoAdmin.getInlinePolicyForPermissionSet({
              InstanceArn: first.instanceArn,
              PermissionSetArn: first.permissionSetArn,
            })).InlinePolicy ?? "",
          ).toBe("");
          expect(
            (yield* ssoAdmin.listAccountsForProvisionedPermissionSet({
              InstanceArn: first.instanceArn,
              PermissionSetArn: first.permissionSetArn,
              ProvisioningStatus: "LATEST_PERMISSION_SET_NOT_PROVISIONED",
            })).AccountIds,
          ).toEqual([]);

          yield* ssoAdmin.deleteInlinePolicyFromPermissionSet({
            InstanceArn: moved.policy.instanceArn,
            PermissionSetArn: moved.policy.permissionSetArn,
          });
          const recreated = yield* stack.deploy(resources(true, "s3:GetObject", false));
          const group = yield* identitystore.describeGroup({
            IdentityStoreId: recreated.observer.identityStoreId,
            GroupId: recreated.observer.groupId,
          });
          expect(
            Redacted.isRedacted(group.Description)
              ? Redacted.value(group.Description)
              : group.Description,
          ).toBe(recreated.policy.policyDocument);
          expect(JSON.parse(recreated.policy.policyDocument).Statement.Sid).toBe(
            "ReadDevelopmentSecrets",
          );
          expect(
            (yield* stack.plan(resources(true, "s3:GetObject", false))).resources.Policy?.action,
          ).toBe("noop");
          const replacementPlan = yield* stack.plan(resources(true, "s3:GetObject", false, true));
          expect(replacementPlan.resources.Second?.action).toBe("replace");
          expect(replacementPlan.resources.Policy?.action).toBe("update");
          expect(replacementPlan.resources.Observer?.action).toBe("update");
          const replaced = yield* stack.deploy(resources(true, "s3:GetObject", false, true));
          expect(replaced.policy.permissionSetArn).not.toBe(recreated.policy.permissionSetArn);
          const replacementObserver = yield* identitystore.describeGroup({
            IdentityStoreId: replaced.observer.identityStoreId,
            GroupId: replaced.observer.groupId,
          });
          expect(
            Redacted.isRedacted(replacementObserver.DisplayName)
              ? Redacted.value(replacementObserver.DisplayName)
              : replacementObserver.DisplayName,
          ).toBe(replaced.policy.permissionSetArn);
          yield* ssoAdmin.deleteInlinePolicyFromPermissionSet({
            InstanceArn: replaced.policy.instanceArn,
            PermissionSetArn: replaced.policy.permissionSetArn,
          });
          // Remove the already-absent policy through the stack while retaining its parent.
          yield* stack.deploy(
            Effect.gen(function* () {
              yield* base;
              yield* PermissionSet("Second", { name: `second-new-${stack.stage}` });
            }),
          );
          expect(
            (yield* ssoAdmin.getInlinePolicyForPermissionSet({
              InstanceArn: replaced.policy.instanceArn,
              PermissionSetArn: replaced.policy.permissionSetArn,
            })).InlinePolicy ?? "",
          ).toBe("");
          yield* stack.destroy();
          yield* stack.destroy();
          expect(
            yield* Effect.flip(
              ssoAdmin.describePermissionSet({
                InstanceArn: first.instanceArn,
                PermissionSetArn: first.permissionSetArn,
              }),
            ),
          ).toMatchObject({ _tag: "ResourceNotFoundException" });
        }),
    );

    test.provider.skipIf(SKIP_IDENTITY_CENTER)(
      "refuses two inline policy owners in one deploy",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const base = PermissionSet("Set", { name: `inline-duplicate-${stack.stage}` });
          const target = yield* stack.deploy(base);
          const firstDocument = inlineDocument("s3:GetObject");
          const secondDocument = inlineDocument("s3:DeleteObject");
          const cause = yield* Effect.flip(
            stack
              .deploy(
                Effect.gen(function* () {
                  yield* base;
                  yield* AWS.IdentityCenter.PermissionSetInlinePolicy("FirstPolicy", {
                    permissionSetArn: target.permissionSetArn,
                    policyDocument: firstDocument,
                  });
                  yield* AWS.IdentityCenter.PermissionSetInlinePolicy("SecondPolicy", {
                    permissionSetArn: target.permissionSetArn,
                    policyDocument: secondDocument,
                  });
                }),
              )
              .pipe(Effect.sandbox),
          );
          const observed = yield* ssoAdmin.getInlinePolicyForPermissionSet({
            InstanceArn: target.instanceArn,
            PermissionSetArn: target.permissionSetArn,
          });
          yield* stack.destroy();
          expect(cause.reasons).toHaveLength(1);
          const error = cause.reasons.find(Cause.isFailReason)?.error;
          expect(error).toMatchObject({ _tag: "OwnedBySomeoneElse" });
          expect(["FirstPolicy", "SecondPolicy"]).toContain(error.logicalId);
          const firstWon = error.logicalId === "SecondPolicy";
          const document = JSON.parse(observed.InlinePolicy!);
          expect(document).toEqual(firstWon ? firstDocument : secondDocument);
          expect(document).not.toEqual(firstWon ? secondDocument : firstDocument);
        }),
    );

    test.provider.skipIf(SKIP_IDENTITY_CENTER)(
      "requires explicit policy adoption, including moves to a foreign target",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const base = Effect.gen(function* () {
            const first = yield* PermissionSet("First", {
              name: `adopt-a-${stack.stage}`,
            });
            const second = yield* PermissionSet("Second", {
              name: `adopt-b-${stack.stage}`,
            });
            return { first, second };
          });
          const targets = yield* stack.deploy(base);
          for (const target of [targets.first, targets.second]) {
            yield* ssoAdmin.putInlinePolicyToPermissionSet({
              InstanceArn: target.instanceArn,
              PermissionSetArn: target.permissionSetArn,
              InlinePolicy: JSON.stringify(inlineDocument("s3:GetObject")),
            });
          }
          const resources = (move: boolean, enabled: boolean) =>
            Effect.gen(function* () {
              yield* base;
              return yield* AWS.IdentityCenter.PermissionSetInlinePolicy("Policy", {
                permissionSetArn: (move ? targets.second : targets.first).permissionSetArn,
                policyDocument: inlineDocument("s3:PutObject"),
              }).pipe(adopt(enabled));
            });
          expect(yield* Effect.flip(stack.deploy(resources(false, false)))).toMatchObject({
            _tag: "OwnedBySomeoneElse",
          });
          expect(
            JSON.parse(
              (yield* ssoAdmin.getInlinePolicyForPermissionSet({
                InstanceArn: targets.first.instanceArn,
                PermissionSetArn: targets.first.permissionSetArn,
              })).InlinePolicy!,
            ).Statement[0].Action,
          ).toEqual(["s3:GetObject"]);
          yield* stack.deploy(resources(false, true));
          expect(yield* Effect.flip(stack.deploy(resources(true, false)))).toMatchObject({
            _tag: "OwnedBySomeoneElse",
          });
          expect(
            JSON.parse(
              (yield* ssoAdmin.getInlinePolicyForPermissionSet({
                InstanceArn: targets.first.instanceArn,
                PermissionSetArn: targets.first.permissionSetArn,
              })).InlinePolicy!,
            ).Statement[0].Action,
          ).toEqual(["s3:PutObject"]);
          expect(
            JSON.parse(
              (yield* ssoAdmin.getInlinePolicyForPermissionSet({
                InstanceArn: targets.second.instanceArn,
                PermissionSetArn: targets.second.permissionSetArn,
              })).InlinePolicy!,
            ).Statement[0].Action,
          ).toEqual(["s3:GetObject"]);
          yield* stack.deploy(resources(true, true));
          expect(
            (yield* ssoAdmin.getInlinePolicyForPermissionSet({
              InstanceArn: targets.first.instanceArn,
              PermissionSetArn: targets.first.permissionSetArn,
            })).InlinePolicy ?? "",
          ).toBe("");
          yield* stack.destroy();
        }),
    );
  },
);

test.provider.skipIf(SKIP_IDENTITY_CENTER)(
  "lifecycle round-trips sessionDuration and list enumerates the set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create with a string Duration.Input — must land on the wire as
      // the canonical ISO-8601 string.
      const permissionSet = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* PermissionSet("ListPermissionSet", {
            name: "alchemy-test-list-permission-set",
            description: "list() coverage test",
            sessionDuration: "1 hour",
          });
        }),
      );

      expect(permissionSet.sessionDuration).toBe("PT1H");

      // Out-of-band wire verification via distilled.
      const described = yield* ssoAdmin.describePermissionSet({
        InstanceArn: permissionSet.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
      });
      expect(described.PermissionSet?.SessionDuration).toBe("PT1H");

      const provider = yield* Provider.findProvider(PermissionSet);
      const all = yield* provider.list();

      const found = all.find((p) => p.permissionSetArn === permissionSet.permissionSetArn);
      expect(found).toBeDefined();
      expect(found?.name).toBe(permissionSet.name);
      expect(found?.instanceArn).toBe(permissionSet.instanceArn);

      // Update with a Duration object — exercises the non-string
      // Duration.Input path and the updatePermissionSet sync branch.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* PermissionSet("ListPermissionSet", {
            name: "alchemy-test-list-permission-set",
            description: "list() coverage test",
            sessionDuration: Duration.minutes(90),
          });
        }),
      );

      expect(updated.permissionSetArn).toBe(permissionSet.permissionSetArn);
      expect(updated.sessionDuration).toBe("PT1H30M");

      const redescribed = yield* ssoAdmin.describePermissionSet({
        InstanceArn: updated.instanceArn,
        PermissionSetArn: updated.permissionSetArn,
      });
      expect(redescribed.PermissionSet?.SessionDuration).toBe("PT1H30M");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:aws", "provider:aws:identitycenter", "live"],
    timeout: 180_000,
  },
);
