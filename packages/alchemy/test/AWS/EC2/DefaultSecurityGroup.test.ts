import * as AWS from "@/AWS";
import {
  DefaultSecurityGroup,
  NetworkInterface,
  PrefixList,
  SecurityGroup,
  Subnet,
  Vpc,
} from "@/AWS/EC2";
import type { SecurityGroupRuleData, VpcId } from "@/AWS/EC2";
import * as Drift from "@/Drift";
import { isActionState, State } from "@/State/State";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Test from "./VpcTest.ts";
import { assertVpcGone } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() }, 2);
const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("AWS creates the default group with its initial rules", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();
    const vpc = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Vpc("DefaultSecurityGroupInitialVpc", {
          cidrBlock: "10.43.0.0/16",
        });
      }),
    );

    const group = yield* findDefaultGroup(vpc.vpcId);
    yield* expectRules(
      group.GroupId!,
      [{ IpProtocol: "-1", ReferencedGroupInfo: { GroupId: group.GroupId! } }],
      [{ IpProtocol: "-1", CidrIpv4: "0.0.0.0/0" }],
    );

    yield* stack.destroy();
    yield* assertVpcGone(vpc.vpcId);
  }).pipe(logLevel),
);

// This changes the AWS-created default security group only inside the VPC this
// test creates and destroys.
test.provider(
  "manages a temporary VPC's default security group without deleting it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The VPC output is consumed in this same first deployment. This proves
      // that the default group can be found and closed without a second deploy.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("DefaultSecurityGroupVpc", {
            cidrBlock: "10.42.0.0/16",
          });
          const defaultSecurityGroup = yield* DefaultSecurityGroup(
            "DefaultSecurityGroup",
            {
              vpcId: vpc.vpcId,
              ingress: [],
              egress: [],
            },
          );
          return { vpc, defaultSecurityGroup };
        }),
      );

      const defaultGroup = yield* findDefaultGroup(initial.vpc.vpcId);
      expect(initial.defaultSecurityGroup.groupId).toEqual(
        defaultGroup.GroupId,
      );
      yield* expectRules(initial.defaultSecurityGroup.groupId, [], []);

      // A second identical deployment verifies idempotence against AWS readback.
      yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("DefaultSecurityGroupVpc", {
            cidrBlock: "10.42.0.0/16",
          });
          return yield* DefaultSecurityGroup("DefaultSecurityGroup", {
            vpcId: vpc.vpcId,
            ingress: [],
            egress: [],
          });
        }),
      );
      yield* expectRules(initial.defaultSecurityGroup.groupId, [], []);

      // A changed complete declaration replaces the rule set.
      yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("DefaultSecurityGroupVpc", {
            cidrBlock: "10.42.0.0/16",
          });
          return yield* DefaultSecurityGroup("DefaultSecurityGroup", {
            vpcId: vpc.vpcId,
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 443,
                toPort: 443,
                cidrIpv4: "10.42.0.0/16",
              },
            ],
            egress: [],
          });
        }),
      );
      yield* expectRules(
        initial.defaultSecurityGroup.groupId,
        [
          {
            IpProtocol: "tcp",
            FromPort: 443,
            ToPort: 443,
            CidrIpv4: "10.42.0.0/16",
          },
        ],
        [],
      );

      // Removing the Alchemy resource must not delete the AWS-owned group or
      // restore its initial AWS rules.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("DefaultSecurityGroupVpc", {
            cidrBlock: "10.42.0.0/16",
          });
        }),
      );
      const preserved = yield* findDefaultGroup(initial.vpc.vpcId);
      expect(preserved.GroupId).toEqual(initial.defaultSecurityGroup.groupId);
      yield* expectRules(
        initial.defaultSecurityGroup.groupId,
        [
          {
            IpProtocol: "tcp",
            FromPort: 443,
            ToPort: 443,
            CidrIpv4: "10.42.0.0/16",
          },
        ],
        [],
      );

      yield* stack.destroy();
      yield* assertVpcGone(initial.vpc.vpcId);
    }).pipe(logLevel),
);

for (const direction of ["ingress", "egress"] as const) {
  test.provider(
    `repairs ${direction} drift and applies only changed rules`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const retained: SecurityGroupRuleData = {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "10.44.0.0/16",
          description: "retained",
        };
        const changed: SecurityGroupRuleData = {
          ipProtocol: "udp",
          fromPort: 53,
          toPort: 53,
          cidrIpv4: "10.44.0.0/16",
          description: "DNS",
        };
        const program = (rules = [retained, changed]) =>
          Effect.gen(function* () {
            const vpc = yield* Vpc("DriftVpc", { cidrBlock: "10.44.0.0/16" });
            const group = yield* DefaultSecurityGroup("DriftGroup", {
              vpcId: vpc.vpcId,
              ingress: direction === "ingress" ? rules : [retained],
              egress: direction === "egress" ? rules : [retained],
            });
            return { vpc, group };
          });
        const created = yield* stack.deploy(program());
        const groupId = created.group.groupId;
        const initial = yield* readRules(groupId);
        const stable = initial.filter((rule) => rule.FromPort === 443);
        expect(stable).toHaveLength(2);
        const missing = initial.find((rule) => rule.FromPort === 53)!;
        const revoke =
          direction === "ingress"
            ? EC2.revokeSecurityGroupIngress
            : EC2.revokeSecurityGroupEgress;
        const authorize =
          direction === "ingress"
            ? EC2.authorizeSecurityGroupIngress
            : EC2.authorizeSecurityGroupEgress;
        yield* revoke({
          GroupId: groupId,
          SecurityGroupRuleIds: [missing.SecurityGroupRuleId!],
        });
        const rogue = yield* authorize({
          GroupId: groupId,
          IpPermissions: [
            {
              IpProtocol: "tcp",
              FromPort: 22,
              ToPort: 22,
              IpRanges: [{ CidrIp: "0.0.0.0/0" }],
            },
          ],
          TagSpecifications: [
            {
              ResourceType: "security-group-rule",
              Tags: [{ Key: "alchemy::id", Value: "DriftGroup" }],
            },
          ],
        });
        const rogueId = rogue.SecurityGroupRules![0]!.SecurityGroupRuleId!;
        yield* waitForRules(
          groupId,
          (rules) =>
            !rules.some(
              (rule) =>
                rule.SecurityGroupRuleId === missing.SecurityGroupRuleId,
            ) && rules.some((rule) => rule.SecurityGroupRuleId === rogueId),
        );
        const missingRuleError = yield* EC2.modifySecurityGroupRules({
          GroupId: groupId,
          SecurityGroupRules: [
            {
              SecurityGroupRuleId: missing.SecurityGroupRuleId!,
              SecurityGroupRule: {
                IpProtocol: "udp",
                FromPort: 53,
                ToPort: 53,
                CidrIpv4: "10.44.0.0/16",
                Description: "missing rule probe",
              },
            },
          ],
        }).pipe(Effect.flip);
        expect(missingRuleError).toMatchObject({
          _tag: "InvalidSecurityGroupRuleId.NotFound",
        });
        expect(
          (yield* stack.plan(program())).resources.DriftGroup?.action,
        ).toBe("update");
        yield* stack.deploy(program());
        const repaired = yield* readRules(groupId);
        expect(repaired).toHaveLength(3);
        expect(repaired).toEqual(expect.arrayContaining(stable));
        const restored = repaired.find((rule) => rule.FromPort === 53)!;
        expect(restored.SecurityGroupRuleId).not.toBe(
          missing.SecurityGroupRuleId,
        );
        expect(restored.IsEgress).toBe(direction === "egress");
        expect(restored.Description).toBe("DNS");
        expect(
          repaired.some((rule) => rule.SecurityGroupRuleId === rogueId),
        ).toBe(false);

        yield* EC2.modifySecurityGroupRules({
          GroupId: groupId,
          SecurityGroupRules: [
            {
              SecurityGroupRuleId: restored.SecurityGroupRuleId!,
              SecurityGroupRule: {
                IpProtocol: "udp",
                FromPort: 53,
                ToPort: 53,
                CidrIpv4: "10.44.0.0/16",
                Description: "external description",
              },
            },
          ],
        });
        yield* waitForRules(groupId, (rules) =>
          rules.some(
            (rule) =>
              rule.SecurityGroupRuleId === restored.SecurityGroupRuleId &&
              rule.Description === "external description",
          ),
        );
        expect(
          (yield* stack.plan(program())).resources.DriftGroup?.action,
        ).toBe("update");
        yield* stack.deploy(program());
        const descriptions = yield* readRules(groupId);
        expect(descriptions).toEqual(
          expect.arrayContaining([...stable, restored]),
        );

        // External identity edits are removed, not preserved as extra access.
        yield* EC2.modifySecurityGroupRules({
          GroupId: groupId,
          SecurityGroupRules: [
            {
              SecurityGroupRuleId: restored.SecurityGroupRuleId!,
              SecurityGroupRule: {
                IpProtocol: "tcp",
                FromPort: 25,
                ToPort: 25,
                CidrIpv4: "0.0.0.0/0",
                Description: "external access",
              },
            },
          ],
        });
        yield* waitForRules(groupId, (rules) =>
          rules.some(
            (rule) =>
              rule.SecurityGroupRuleId === restored.SecurityGroupRuleId &&
              rule.FromPort === 25,
          ),
        );
        expect(
          (yield* stack.plan(program())).resources.DriftGroup?.action,
        ).toBe("update");
        yield* stack.deploy(program());
        const repairedIdentity = yield* readRules(groupId);
        expect(repairedIdentity).toHaveLength(3);
        expect(repairedIdentity).toEqual(expect.arrayContaining(stable));
        expect(repairedIdentity.some((rule) => rule.FromPort === 25)).toBe(
          false,
        );
        expect(
          repairedIdentity.find((rule) => rule.FromPort === 53)?.Description,
        ).toBe("DNS");

        const replacement = {
          ...changed,
          fromPort: 123,
          toPort: 123,
          description: "NTP",
        };
        yield* stack.deploy(program([retained, replacement]));
        const edited = yield* readRules(groupId);
        expect(edited).toHaveLength(3);
        expect(edited).toEqual(expect.arrayContaining(stable));
        expect(edited.some((rule) => rule.FromPort === 53)).toBe(false);
        expect(edited.find((rule) => rule.FromPort === 123)?.Description).toBe(
          "NTP",
        );

        yield* stack.deploy(program([]));
        const opposite = stable.filter(
          (rule) => rule.IsEgress !== (direction === "egress"),
        );
        expect(yield* readRules(groupId)).toEqual(opposite);
        const external = yield* authorize({
          GroupId: groupId,
          IpPermissions: [
            { IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] },
          ],
        });
        yield* waitForRules(groupId, (rules) =>
          rules.some(
            (rule) =>
              rule.SecurityGroupRuleId ===
              external.SecurityGroupRules![0]!.SecurityGroupRuleId,
          ),
        );
        expect(
          (yield* stack.plan(program([]))).resources.DriftGroup?.action,
        ).toBe("update");
        yield* stack.deploy(program([]));
        expect(yield* readRules(groupId)).toEqual(opposite);

        const observer = yield* observeRuleRequests;
        yield* Effect.gen(function* () {
          expect(
            (yield* stack.plan(program([]))).resources.DriftGroup?.action,
          ).toBe("noop");
          yield* stack.deploy(program([]));
        }).pipe(Effect.provideService(HttpClient.HttpClient, observer.client));
        expect(observer.requests.length).toBeGreaterThan(0);
        expect(observer.requests.filter((request) => request.write)).toEqual(
          [],
        );
        expect(yield* readRules(groupId)).toEqual(opposite);
        yield* stack.destroy();
        yield* assertVpcGone(created.vpc.vpcId);
      }).pipe(logLevel),
    { timeout: 120_000 },
  );
}

test.provider(
  "canonicalizes and deduplicates rules while preserving IDs and updating descriptions in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const dual: SecurityGroupRuleData = {
        ipProtocol: "6",
        fromPort: 443,
        toPort: 443,
        cidrIpv4: "10.45.0.7/16",
        cidrIpv6: "2001:0DB8:0:0:0:0:0:5/64",
        description: "HTTPS",
      };
      const supplied: SecurityGroupRuleData[] = [
        dual,
        { ...dual, cidrIpv4: "10.45.0.0/16" },
        { ipProtocol: "58", cidrIpv6: "2001:db8::1/64" },
        {
          ipProtocol: "-1",
          fromPort: 0,
          toPort: 65535,
          cidrIpv4: "10.46.0.1/16",
        },
        {
          ipProtocol: "50",
          fromPort: 0,
          toPort: 65535,
          cidrIpv4: "10.47.0.1/16",
        },
        {
          ipProtocol: "17",
          fromPort: 53,
          toPort: 53,
          cidrIpv4: "10.45.0.7/16",
        },
        { ipProtocol: "1", fromPort: 8, toPort: -1, cidrIpv4: "10.45.0.7/16" },
      ];
      const canonical: SecurityGroupRuleData[] = [
        {
          ipProtocol: "icmp",
          fromPort: 8,
          toPort: -1,
          cidrIpv4: "10.45.0.0/16",
        },
        {
          ipProtocol: "udp",
          fromPort: 53,
          toPort: 53,
          cidrIpv4: "10.45.0.0/16",
        },
        { ipProtocol: "50", cidrIpv4: "10.47.0.0/16" },
        { ipProtocol: "-1", cidrIpv4: "10.46.0.0/16" },
        {
          ipProtocol: "icmpv6",
          fromPort: -1,
          toPort: -1,
          cidrIpv6: "2001:db8::/64",
        },
        {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv6: "2001:db8::/64",
          description: "HTTPS",
        },
        {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "10.45.0.0/16",
          description: "HTTPS",
        },
      ];
      const program = (rules: SecurityGroupRuleData[]) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("CanonicalVpc", { cidrBlock: "10.45.0.0/16" });
          const group = yield* DefaultSecurityGroup("CanonicalGroup", {
            vpcId: vpc.vpcId,
            ingress: rules,
            egress: rules,
          });
          return { vpc, group };
        });
      const created = yield* stack.deploy(program(supplied));
      const groupId = created.group.groupId;
      const initial = yield* readRules(groupId);
      expect(initial).toHaveLength(14);
      for (const isEgress of [false, true]) {
        const rules = initial.filter((rule) => rule.IsEgress === isEgress);
        expect(rules).toHaveLength(7);
        expect(rules.filter((rule) => rule.IpProtocol === "tcp")).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              CidrIpv4: "10.45.0.0/16",
              Description: "HTTPS",
            }),
            expect.objectContaining({
              CidrIpv6: "2001:db8::/64",
              Description: "HTTPS",
            }),
          ]),
        );
        expect(
          rules.some(
            (rule) =>
              ["58", "icmpv6"].includes(rule.IpProtocol!) &&
              rule.FromPort === -1 &&
              rule.ToPort === -1,
          ),
        ).toBe(true);
      }
      expect(
        (yield* stack.plan(program(supplied))).resources.CanonicalGroup?.action,
      ).toBe("noop");
      const observer = yield* observeRuleRequests;
      yield* stack
        .deploy(program(canonical))
        .pipe(Effect.provideService(HttpClient.HttpClient, observer.client));
      expect(observer.requests.length).toBeGreaterThan(0);
      expect(observer.requests.filter((request) => request.write)).toEqual([]);
      expect(yield* readRules(groupId)).toEqual(
        expect.arrayContaining(initial),
      );
      expect(yield* readRules(groupId)).toHaveLength(initial.length);

      for (const description of ["Updated HTTPS", undefined]) {
        const desired = canonical.map((rule) =>
          rule.ipProtocol === "tcp" ? { ...rule, description } : rule,
        );
        const writes = yield* observeRuleRequests;
        yield* stack
          .deploy(program(desired))
          .pipe(Effect.provideService(HttpClient.HttpClient, writes.client));
        const mutations = writes.requests.filter((request) => request.write);
        expect(mutations.length).toBeGreaterThan(0);
        expect(
          mutations.every(
            (request) => request.action === "ModifySecurityGroupRules",
          ),
        ).toBe(true);
        expect(
          [...new Set(mutations.flatMap((request) => request.ruleIds))].sort(),
        ).toEqual(
          initial
            .filter((rule) => rule.IpProtocol === "tcp")
            .map((rule) => rule.SecurityGroupRuleId)
            .sort(),
        );
        const observed = yield* readRules(groupId);
        expect(observed.map((rule) => rule.SecurityGroupRuleId).sort()).toEqual(
          initial.map((rule) => rule.SecurityGroupRuleId).sort(),
        );
        for (const rule of observed) {
          if (rule.IpProtocol === "tcp")
            expect(rule.Description ?? "").toBe(description ?? "");
        }
        expect(
          (yield* stack.plan(program(desired))).resources.CanonicalGroup
            ?.action,
        ).toBe("noop");
        const noop = yield* observeRuleRequests;
        yield* stack
          .deploy(program(desired))
          .pipe(Effect.provideService(HttpClient.HttpClient, noop.client));
        expect(noop.requests.length).toBeGreaterThan(0);
        expect(noop.requests.filter((request) => request.write)).toEqual([]);
      }
      yield* stack.destroy();
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "recovers cold state and adopts existing default-group rules authoritatively",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (port: number, vpcId?: VpcId) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("RecoveryVpc", { cidrBlock: "10.48.0.0/16" });
          const group = yield* DefaultSecurityGroup("RecoveryGroup", {
            vpcId: vpcId ?? vpc.vpcId,
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: port,
                toPort: port,
                cidrIpv4: "10.48.0.0/16",
              },
            ],
            egress: [],
          });
          return { vpc, group };
        });
      const created = yield* stack.deploy(program(443));
      const key = {
        stack: stack.name,
        stage: stack.stage,
        fqn: "RecoveryGroup",
      };
      const state = yield* Effect.gen(function* () {
        return yield* yield* State;
      }).pipe(Effect.provide(stack.state));
      const row = yield* state.get(key);
      if (
        !row ||
        isActionState(row) ||
        (row.status !== "created" && row.status !== "updated")
      ) {
        return yield* Effect.fail(
          new Error("Expected a persisted default security group"),
        );
      }
      const rules = yield* readRules(created.group.groupId);
      yield* state.set({
        ...key,
        value: { ...row, status: "creating", attr: undefined },
      });
      const recoveryPlan = yield* stack.plan(program(443, created.vpc.vpcId));
      expect(recoveryPlan.resources.RecoveryGroup?.state?.attr?.groupId).toBe(
        created.group.groupId,
      );
      const observer = yield* observeRuleRequests;
      const recovered = yield* stack
        .deploy(program(443, created.vpc.vpcId))
        .pipe(Effect.provideService(HttpClient.HttpClient, observer.client));
      expect(recovered.group.groupId).toBe(created.group.groupId);
      expect(observer.requests.length).toBeGreaterThan(0);
      expect(observer.requests.filter((request) => request.write)).toEqual([]);
      expect(yield* readRules(created.group.groupId)).toEqual(rules);

      // Lose only the managed-group row; the VPC remains tracked for cleanup.
      yield* state.delete(key);
      const adoptedPlan = yield* stack.plan(program(8443, created.vpc.vpcId));
      expect(adoptedPlan.resources.RecoveryGroup?.state?.attr?.groupId).toBe(
        created.group.groupId,
      );
      const adopted = yield* stack.deploy(program(8443, created.vpc.vpcId));
      expect(adopted.group.groupId).toBe(created.group.groupId);
      yield* expectRules(
        created.group.groupId,
        [
          {
            IpProtocol: "tcp",
            FromPort: 8443,
            ToPort: 8443,
            CidrIpv4: "10.48.0.0/16",
          },
        ],
        [],
      );
      expect(
        (yield* stack.plan(program(8443, created.vpc.vpcId))).resources
          .RecoveryGroup?.action,
      ).toBe("noop");
      yield* stack.destroy();
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "reads a missing VPC as absent and destroys stale state idempotently",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("MissingVpc", { cidrBlock: "10.49.0.0/16" });
          const group = yield* DefaultSecurityGroup("MissingGroup", {
            vpcId: vpc.vpcId,
            ingress: [],
            egress: [],
          });
          return { vpc, group };
        }),
      );
      yield* EC2.deleteVpc({ VpcId: created.vpc.vpcId });
      yield* assertVpcGone(created.vpc.vpcId);
      const drift = yield* Drift.detect(stack).pipe(
        Effect.provide(stack.state),
      );
      expect(drift.resources.MissingGroup?.action).toBe("missing");
      expect(drift.resources.MissingGroup?.attr).toBeUndefined();
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: stack.stage,
          fqn: "MissingGroup",
        });
      }).pipe(Effect.provide(stack.state));
      const cold = yield* stack.plan(
        Effect.gen(function* () {
          yield* Vpc("MissingVpc", { cidrBlock: "10.49.0.0/16" });
          return yield* DefaultSecurityGroup("MissingGroup", {
            vpcId: created.vpc.vpcId,
            ingress: [],
            egress: [],
          });
        }),
      );
      expect(cold.resources.MissingGroup?.action).toBe("create");
      expect(cold.resources.MissingGroup?.state).toBeUndefined();
      yield* stack.destroy();
      yield* stack.destroy();
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replaces VPC identity while retaining the old group's last-applied rules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (useSecond: boolean, keepFirst = true) =>
        Effect.gen(function* () {
          const first = keepFirst
            ? yield* Vpc("FirstVpc", { cidrBlock: "10.50.0.0/16" })
            : undefined;
          const second = yield* Vpc("SecondVpc", { cidrBlock: "10.51.0.0/16" });
          const group = yield* DefaultSecurityGroup("MovingGroup", {
            vpcId: useSecond ? second.vpcId : first!.vpcId,
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 443,
                toPort: 443,
                cidrIpv4: "10.50.0.0/16",
              },
            ],
            egress: [],
          });
          return { first, second, group };
        });
      const created = yield* stack.deploy(program(false));
      const oldVpcId = created.first!.vpcId;
      const oldRules = yield* readRules(created.group.groupId);
      expect(oldRules).toHaveLength(1);
      expect(
        (yield* stack.plan(program(true))).resources.MovingGroup?.action,
      ).toBe("replace");
      const moved = yield* stack.deploy(program(true));
      expect(moved.group.groupId).not.toBe(created.group.groupId);
      expect(moved.group.vpcId).toBe(created.second.vpcId);
      expect((yield* findDefaultGroup(oldVpcId)).GroupId).toBe(
        created.group.groupId,
      );
      expect(yield* readRules(created.group.groupId)).toEqual(oldRules);
      yield* expectRules(
        moved.group.groupId,
        [
          {
            IpProtocol: "tcp",
            FromPort: 443,
            ToPort: 443,
            CidrIpv4: "10.50.0.0/16",
          },
        ],
        [],
      );
      const newRules = yield* readRules(moved.group.groupId);
      // Remove the old dependency only after its resource replacement is complete.
      yield* stack.deploy(program(true, false));
      yield* assertVpcGone(oldVpcId);
      expect(yield* readRules(moved.group.groupId)).toEqual(newRules);
      expect(
        (yield* stack.plan(program(true, false))).resources.MovingGroup?.action,
      ).toBe("noop");
      yield* stack.destroy();
      yield* assertVpcGone(created.second.vpcId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

for (const scenario of [
  "new destination VPC",
  "upstream VPC replacement",
] as const) {
  test.provider(
    `propagates unresolved group identity to a real ENI during ${scenario}`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = (switchVpc: boolean) =>
          Effect.gen(function* () {
            const original = yield* Vpc("IdentityVpc", {
              cidrBlock:
                switchVpc && scenario === "upstream VPC replacement"
                  ? "10.53.0.0/16"
                  : "10.52.0.0/16",
            });
            // Keep the original VPC declared while introducing its destination.
            const destination =
              switchVpc && scenario === "new destination VPC"
                ? yield* Vpc("DestinationVpc", { cidrBlock: "10.53.0.0/16" })
                : original;
            const group = yield* DefaultSecurityGroup("IdentityGroup", {
              vpcId: destination.vpcId,
              ingress: [
                {
                  ipProtocol: "tcp",
                  fromPort: 443,
                  toPort: 443,
                  cidrIpv4: "10.52.0.0/16",
                },
              ],
              egress: [],
            });
            const subnet = switchVpc
              ? yield* Subnet("ConsumerSubnet", {
                  vpcId: destination.vpcId,
                  cidrBlock: "10.53.1.0/24",
                })
              : undefined;
            const eni = subnet
              ? yield* NetworkInterface("ConsumerInterface", {
                  subnetId: subnet.subnetId,
                  securityGroupIds: [group.groupId],
                })
              : undefined;
            return { original, destination, group, subnet, eni };
          });
        const created = yield* stack.deploy(program(false));
        const oldRules = yield* readRules(created.group.groupId);
        const plan = yield* stack.plan(program(true));
        expect(plan.resources.IdentityGroup?.action).toBe("replace");
        expect(plan.resources.IdentityVpc?.action).toBe(
          scenario === "upstream VPC replacement" ? "replace" : "noop",
        );
        if (scenario === "new destination VPC") {
          expect(plan.resources.DestinationVpc?.action).toBe("create");
        }
        expect(plan.resources.ConsumerInterface?.action).toBe("create");
        const moved = yield* stack.deploy(program(true));
        expect(moved.group.groupId).not.toBe(created.group.groupId);
        expect(moved.destination.vpcId).not.toBe(created.destination.vpcId);
        expect(moved.group.vpcId).toBe(moved.destination.vpcId);
        const observed = (yield* EC2.describeNetworkInterfaces({
          NetworkInterfaceIds: [moved.eni!.networkInterfaceId],
        })).NetworkInterfaces?.[0];
        expect(observed?.VpcId).toBe(moved.destination.vpcId);
        expect(observed?.SubnetId).toBe(moved.subnet!.subnetId);
        expect(observed?.Groups?.map((group) => group.GroupId)).toEqual([
          moved.group.groupId,
        ]);
        if (scenario === "new destination VPC") {
          expect(
            (yield* findDefaultGroup(created.original.vpcId)).GroupId,
          ).toBe(created.group.groupId);
          expect(yield* readRules(created.group.groupId)).toEqual(oldRules);
        } else {
          yield* assertVpcGone(created.original.vpcId);
        }
        const noop = yield* stack.plan(program(true));
        expect(noop.resources.IdentityGroup?.action).toBe("noop");
        expect(noop.resources.ConsumerInterface?.action).toBe("noop");
        yield* stack.destroy();
        yield* assertVpcGone(created.original.vpcId);
        yield* assertVpcGone(moved.destination.vpcId);
      }).pipe(logLevel),
    { timeout: 120_000 },
  );
}

test.provider(
  "manages group and prefix-list sources and rejects invalid rules without writes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (
        description?: string,
        directions?: {
          ingress: SecurityGroupRuleData[];
          egress: SecurityGroupRuleData[];
        },
      ) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("SourcesVpc", { cidrBlock: "10.54.0.0/16" });
          const peer = yield* SecurityGroup("SourcePeer", {
            vpcId: vpc.vpcId,
            egress: [],
          });
          const prefix = yield* PrefixList("SourcePrefix", {
            maxEntries: 1,
            entries: [{ cidr: "10.54.0.0/16" }],
          });
          const rule = {
            ipProtocol: "tcp",
            fromPort: 443,
            toPort: 443,
            referencedGroupId: peer.groupId,
            prefixListId: prefix.prefixListId,
            description,
          };
          const group = yield* DefaultSecurityGroup("SourcesGroup", {
            vpcId: vpc.vpcId,
            ingress: directions?.ingress ?? [rule],
            egress: directions?.egress ?? [rule],
          });
          return { vpc, peer, prefix, group };
        });
      const created = yield* stack.deploy(program("Before"));
      const groupId = created.group.groupId;
      yield* Effect.gen(function* () {
        const initial = yield* readRules(groupId);
        expect(initial).toHaveLength(4);
        for (const isEgress of [false, true]) {
          const rules = initial.filter((rule) => rule.IsEgress === isEgress);
          expect(rules).toHaveLength(2);
          expect(rules).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                ReferencedGroupInfo: expect.objectContaining({
                  GroupId: created.peer.groupId,
                }),
                Description: "Before",
              }),
              expect.objectContaining({
                PrefixListId: created.prefix.prefixListId,
                Description: "Before",
              }),
            ]),
          );
        }
        for (const description of ["After", undefined]) {
          const observer = yield* observeRuleRequests;
          yield* stack
            .deploy(program(description))
            .pipe(
              Effect.provideService(HttpClient.HttpClient, observer.client),
            );
          const rules = yield* readRules(groupId);
          expect(rules).toHaveLength(4);
          expect(rules.map((rule) => rule.SecurityGroupRuleId).sort()).toEqual(
            initial.map((rule) => rule.SecurityGroupRuleId).sort(),
          );
          for (const original of initial) {
            const rule = rules.find(
              (rule) =>
                rule.SecurityGroupRuleId === original.SecurityGroupRuleId,
            )!;
            expect(rule.IsEgress).toBe(original.IsEgress);
            expect(rule.ReferencedGroupInfo?.GroupId).toBe(
              original.ReferencedGroupInfo?.GroupId,
            );
            expect(rule.PrefixListId).toBe(original.PrefixListId);
            expect(rule.Description ?? "").toBe(description ?? "");
          }
          const writes = observer.requests.filter((request) => request.write);
          expect(writes.length).toBeGreaterThan(0);
          expect(
            writes.every(
              (request) => request.action === "ModifySecurityGroupRules",
            ),
          ).toBe(true);
          expect(
            [...new Set(writes.flatMap((request) => request.ruleIds))].sort(),
          ).toEqual(initial.map((rule) => rule.SecurityGroupRuleId).sort());
        }
        const settled = yield* readRules(groupId);
        const invalid: Array<{
          rules: SecurityGroupRuleData[];
          message: string;
        }> = [
          {
            rules: [
              {
                ipProtocol: "tcp",
                fromPort: 443,
                toPort: 443,
                cidrIpv4: "10.54.0.7/16",
                description: "one",
              },
              {
                ipProtocol: "6",
                fromPort: 443,
                toPort: 443,
                cidrIpv4: "10.54.0.0/16",
                description: "two",
              },
            ],
            message: "Duplicate rules must have the same description.",
          },
          {
            rules: [{ ipProtocol: "tcp", fromPort: 443, toPort: 443 }],
            message: "Every rule must specify a protocol and a source.",
          },
          {
            rules: [{ ipProtocol: "", cidrIpv4: "10.54.0.0/16" }],
            message: "Every rule must specify a protocol and a source.",
          },
        ];
        for (const { rules, message } of invalid) {
          const observer = yield* observeRuleRequests;
          const error = yield* stack
            .deploy(program(undefined, { ingress: [], egress: rules }))
            .pipe(
              Effect.provideService(HttpClient.HttpClient, observer.client),
              Effect.flip,
            );
          expect(error).toMatchObject({
            _tag: "InvalidDefaultSecurityGroupRules",
            message,
          });
          expect(observer.requests.filter((request) => request.write)).toEqual(
            [],
          );
          expect(yield* readRules(groupId)).toEqual(
            expect.arrayContaining(settled),
          );
          expect(yield* readRules(groupId)).toHaveLength(settled.length);
        }
        expect(
          (yield* stack.plan(program())).resources.SourcesGroup?.action,
        ).toBe("noop");
      }).pipe(
        // Release source references even when an assertion fails before teardown.
        Effect.ensuring(
          stack
            .deploy(program(undefined, { ingress: [], egress: [] }))
            .pipe(Effect.ignore),
        ),
      );
      expect(yield* readRules(groupId)).toEqual([]);
      yield* stack.destroy();
      yield* assertVpcGone(created.vpc.vpcId);
      const prefixGone = yield* EC2.describeManagedPrefixLists({
        PrefixListIds: [created.prefix.prefixListId],
      }).pipe(
        Effect.map((result) =>
          (result.PrefixLists ?? []).every(
            (list) => list.State === "delete-complete",
          ),
        ),
        Effect.catchTag("InvalidPrefixListID.NotFound", () =>
          Effect.succeed(true),
        ),
        Effect.repeat({
          until: Boolean,
          schedule: Schedule.spaced("1 second"),
          times: 8,
        }),
      );
      expect(prefixGone).toBe(true);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

const observeRuleRequests = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const requests: Array<{ action: string; write: boolean; ruleIds: string[] }> =
    [];
  return {
    requests,
    client: client.pipe(
      HttpClient.tapRequest((request) =>
        Effect.sync(() => {
          if (request.body._tag !== "Uint8Array") return;
          const parameters = new URLSearchParams(
            new TextDecoder().decode(request.body.body),
          );
          const action = parameters.get("Action");
          if (!action?.includes("SecurityGroup")) return;
          requests.push({
            action,
            write: !action.startsWith("Describe"),
            ruleIds: [...parameters.entries()]
              .filter(([key]) => key.endsWith(".SecurityGroupRuleId"))
              .map(([, value]) => value),
          });
        }),
      ),
    ),
  };
});

const waitForRules = Effect.fn(function* (
  groupId: string,
  matches: (rules: EC2.SecurityGroupRule[]) => boolean,
) {
  const rules = yield* readRules(groupId).pipe(
    Effect.repeat({
      until: matches,
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );
  expect(matches(rules)).toBe(true);
  return rules;
});

const findDefaultGroup = Effect.fn(function* (vpcId: string) {
  const group = yield* EC2.describeSecurityGroups({
    Filters: [
      { Name: "vpc-id", Values: [vpcId] },
      { Name: "group-name", Values: ["default"] },
    ],
  }).pipe(
    Effect.map((result) => result.SecurityGroups?.[0]),
    Effect.repeat({
      until: (group) => !!group?.GroupId,
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );
  if (!group?.GroupId) {
    return yield* Effect.fail(
      new Error(`Default group for ${vpcId} was not found`),
    );
  }
  return group;
});

const readRules = (groupId: string) =>
  EC2.describeSecurityGroupRules
    .items({ Filters: [{ Name: "group-id", Values: [groupId] }] })
    .pipe(
      Stream.runCollect,
      Effect.map((rules) => Array.from(rules)),
    );

const expectRules = Effect.fn(function* (
  groupId: string,
  ingress: Partial<EC2.SecurityGroupRule>[],
  egress: Partial<EC2.SecurityGroupRule>[],
) {
  const rules = yield* readRules(groupId);
  expect(rules.filter((rule) => !rule.IsEgress)).toEqual(
    ingress.map((rule) => expect.objectContaining(rule)),
  );
  expect(rules.filter((rule) => rule.IsEgress)).toEqual(
    egress.map((rule) => expect.objectContaining(rule)),
  );
});
