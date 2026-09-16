import * as AWS from "@/AWS";
import { SecurityGroup, SecurityGroupRule, Vpc } from "@/AWS/EC2";
import type {
  SecurityGroupProps,
  SecurityGroupRuleData,
} from "@/AWS/EC2/SecurityGroup.ts";
import * as Provider from "@/Provider";
import * as Test from "./VpcTest.ts";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { assertSecurityGroupGone, assertVpcGone } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "creates and updates explicitly empty egress",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (egress: SecurityGroupRuleData[]) =>
        stack.deploy(
          Effect.gen(function* () {
            const vpc = yield* Vpc("EmptyEgressVpc", {
              cidrBlock: "10.0.0.0/16",
            });
            const sg = yield* SecurityGroup("EmptyEgressSg", {
              vpcId: vpc.vpcId,
              egress,
            });
            return { vpc, sg };
          }),
        );
      const created = yield* deploy([]);
      const initial = yield* ec2.describeSecurityGroupRules({
        Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
      });
      expect(initial.SecurityGroupRules).toEqual([]);
      const configured = yield* deploy([
        {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "0.0.0.0/0",
        },
      ]);
      expect(configured.sg.groupId).toBe(created.sg.groupId);
      const configuredRules = yield* ec2.describeSecurityGroupRules({
        Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
      });
      expect(configuredRules.SecurityGroupRules).toEqual([
        expect.objectContaining({
          IsEgress: true,
          IpProtocol: "tcp",
          FromPort: 443,
          ToPort: 443,
          CidrIpv4: "0.0.0.0/0",
        }),
      ]);
      const updated = yield* deploy([]);
      expect(updated.sg.groupId).toBe(created.sg.groupId);
      const final = yield* ec2.describeSecurityGroupRules({
        Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
      });
      expect(final.SecurityGroupRules).toEqual([]);
      yield* stack.destroy();
      yield* assertSecurityGroupGone(created.sg.groupId);
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 120000 },
);

test.provider("list enumerates the deployed Security Group", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { vpc, sg } = yield* stack.deploy(
      Effect.gen(function* () {
        const vpc = yield* Vpc("ListSgVpc", {
          cidrBlock: "10.0.0.0/16",
        });
        const sg = yield* SecurityGroup("ListSg", {
          vpcId: vpc.vpcId,
        });
        return { vpc, sg };
      }),
    );

    const provider = yield* Provider.findProvider(SecurityGroup);
    const all = yield* provider.list();

    expect(all.some((x) => x.groupId === sg.groupId)).toBe(true);

    yield* stack.destroy();

    yield* assertSecurityGroupGone(sg.groupId);
    yield* assertVpcGone(vpc.vpcId);
  }).pipe(logLevel),
);

test.provider(
  "preserves standalone rules across a group tag update",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (label: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const vpc = yield* Vpc("StandaloneVpc", {
              cidrBlock: "10.0.0.0/16",
            });
            const sg = yield* SecurityGroup("StandaloneSg", {
              vpcId: vpc.vpcId,
              tags: { Label: label },
            });
            const rule = yield* SecurityGroupRule("StandaloneIngress", {
              groupId: sg.groupId,
              type: "ingress",
              ipProtocol: "tcp",
              fromPort: 443,
              toPort: 443,
              cidrIpv4: "10.0.0.0/16",
            });
            const egressRule = yield* SecurityGroupRule("StandaloneEgress", {
              groupId: sg.groupId,
              type: "egress",
              ipProtocol: "tcp",
              fromPort: 443,
              toPort: 443,
              cidrIpv4: "10.0.0.0/16",
            });
            return { vpc, sg, rule, egressRule };
          }),
        );
      const created = yield* deploy("before");
      const initial = yield* ec2.describeSecurityGroupRules({
        Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
      });
      expect(initial.SecurityGroupRules).toHaveLength(3);
      expect(initial.SecurityGroupRules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            IsEgress: true,
            IpProtocol: "-1",
            CidrIpv4: "0.0.0.0/0",
          }),
          expect.objectContaining({
            SecurityGroupRuleId: created.rule.securityGroupRuleId,
            IsEgress: false,
          }),
          expect.objectContaining({
            SecurityGroupRuleId: created.egressRule.securityGroupRuleId,
            IsEgress: true,
          }),
        ]),
      );
      const updated = yield* deploy("after");
      expect(updated.sg.groupId).toBe(created.sg.groupId);
      const group = yield* ec2.describeSecurityGroups({
        GroupIds: [created.sg.groupId],
      });
      expect(group.SecurityGroups?.[0]?.Tags).toEqual(
        expect.arrayContaining([{ Key: "Label", Value: "after" }]),
      );
      expect(updated.egressRule.securityGroupRuleId).toBe(
        created.egressRule.securityGroupRuleId,
      );
      const after = yield* ec2.describeSecurityGroupRules({
        Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
      });
      expect(after.SecurityGroupRules).toHaveLength(3);
      expect(after.SecurityGroupRules).toEqual(
        expect.arrayContaining(initial.SecurityGroupRules ?? []),
      );
      expect(updated.rule.securityGroupRuleId).toBe(
        created.rule.securityGroupRuleId,
      );
      const rules = yield* ec2.describeSecurityGroupRules({
        SecurityGroupRuleIds: [created.rule.securityGroupRuleId],
      });
      expect(rules.SecurityGroupRules?.[0]?.GroupId).toBe(created.sg.groupId);
      yield* stack.destroy();
      yield* assertSecurityGroupGone(created.sg.groupId);
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 120000 },
);

test.provider(
  "repairs inline drift without replacing unchanged rules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const vpc = yield* Vpc("InlineDriftVpc", {
              cidrBlock: "10.0.0.0/16",
            });
            const sg = yield* SecurityGroup("InlineDriftSg", {
              vpcId: vpc.vpcId,
              ingress: [
                {
                  ipProtocol: "tcp",
                  fromPort: 443,
                  toPort: 443,
                  cidrIpv4: "10.0.0.0/16",
                },
              ],
              egress: [],
            });
            return { vpc, sg };
          }),
        );
      const created = yield* deploy();
      const originalRuleId = created.sg.ingressRules?.[0]?.securityGroupRuleId;
      yield* ec2.authorizeSecurityGroupIngress({
        GroupId: created.sg.groupId,
        IpPermissions: [
          {
            IpProtocol: "tcp",
            FromPort: 22,
            ToPort: 22,
            IpRanges: [{ CidrIp: "10.0.0.0/16" }],
          },
        ],
      });
      const updated = yield* deploy();
      expect(updated.sg.groupId).toBe(created.sg.groupId);
      const rules = yield* ec2.describeSecurityGroupRules({
        Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
      });
      expect(rules.SecurityGroupRules).toEqual([
        expect.objectContaining({
          SecurityGroupRuleId: originalRuleId,
          FromPort: 443,
        }),
      ]);
      yield* stack.destroy();
      yield* assertSecurityGroupGone(created.sg.groupId);
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 120000 },
);

test.provider(
  "omitted directions retain rules while empty directions revoke only their own rules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const makeStack = (
        directions: Pick<SecurityGroupProps, "ingress" | "egress">,
        label: string,
      ) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("DirectionsVpc", { cidrBlock: "10.0.0.0/16" });
          const sg = yield* SecurityGroup("DirectionsSg", {
            vpcId: vpc.vpcId,
            ...directions,
            tags: { Label: label },
          });
          return { vpc, sg };
        });
      const rule: SecurityGroupRuleData = {
        ipProtocol: "tcp",
        fromPort: 443,
        toPort: 443,
        cidrIpv4: "10.0.0.0/16",
      };
      const created = yield* stack.deploy(
        makeStack({ ingress: [rule], egress: [rule] }, "managed"),
      );
      const readRules = () =>
        ec2.describeSecurityGroupRules({
          Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
        });
      const initial = yield* readRules();
      expect(initial.SecurityGroupRules).toHaveLength(2);
      const unmanaged = yield* stack.deploy(makeStack({}, "unmanaged"));
      expect(unmanaged.sg.groupId).toBe(created.sg.groupId);
      const retained = yield* readRules();
      expect(retained.SecurityGroupRules).toHaveLength(2);
      expect(retained.SecurityGroupRules).toEqual(
        expect.arrayContaining(initial.SecurityGroupRules ?? []),
      );

      const ingressEmpty = yield* stack.deploy(
        makeStack({ ingress: [] }, "ingress-empty"),
      );
      expect(ingressEmpty.sg.groupId).toBe(created.sg.groupId);
      const egressOnly = yield* readRules();
      expect(egressOnly.SecurityGroupRules).toEqual(
        initial.SecurityGroupRules?.filter((rule) => rule.IsEgress === true),
      );

      const emptyStack = makeStack({ egress: [] }, "egress-empty");
      const empty = yield* stack.deploy(emptyStack);
      expect(empty.sg.groupId).toBe(created.sg.groupId);
      expect((yield* readRules()).SecurityGroupRules).toEqual([]);
      const plan = yield* stack.plan(emptyStack);
      expect(plan.resources.DirectionsSg).toMatchObject({ action: "noop" });
      yield* stack.deploy(emptyStack);
      expect((yield* readRules()).SecurityGroupRules).toEqual([]);
      yield* stack.destroy();
      yield* assertSecurityGroupGone(created.sg.groupId);
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 120000 },
);

test.provider(
  "updates and clears inline descriptions without replacing ingress or egress rule IDs",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const makeStack = (description: string | undefined) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("DescriptionsVpc", {
            cidrBlock: "10.0.0.0/16",
          });
          const rule: SecurityGroupRuleData = {
            ipProtocol: "tcp",
            fromPort: 443,
            toPort: 443,
            cidrIpv4: "10.0.0.0/16",
            description,
          };
          const sg = yield* SecurityGroup("DescriptionsSg", {
            vpcId: vpc.vpcId,
            ingress: [rule],
            egress: [rule],
          });
          return { vpc, sg };
        });
      const created = yield* stack.deploy(makeStack("before"));
      const readRules = () =>
        ec2.describeSecurityGroupRules({
          Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
        });
      const initial = yield* readRules();
      expect(initial.SecurityGroupRules).toHaveLength(2);
      for (const rule of initial.SecurityGroupRules ?? []) {
        expect(rule.SecurityGroupRuleId).toMatch(/^sgr-/);
        expect(rule.Description).toBe("before");
      }
      for (const description of ["after", "", undefined]) {
        const updated = yield* stack.deploy(makeStack(description));
        expect(updated.sg.groupId).toBe(created.sg.groupId);
        expect(updated.sg.groupArn).toBe(created.sg.groupArn);
        expect(updated.sg.ownerId).toBe(created.sg.ownerId);
        const observed = yield* readRules();
        expect(observed.SecurityGroupRules).toHaveLength(2);
        for (const original of initial.SecurityGroupRules ?? []) {
          const rule = observed.SecurityGroupRules?.find(
            (rule) => rule.SecurityGroupRuleId === original.SecurityGroupRuleId,
          );
          expect(rule).toBeDefined();
          expect(rule?.IsEgress).toBe(original.IsEgress);
          expect(rule?.Description ?? "").toBe(description ?? "");
        }
      }
      const plan = yield* stack.plan(makeStack(undefined));
      expect(plan.resources.DescriptionsSg).toMatchObject({ action: "noop" });
      yield* stack.destroy();
      yield* assertSecurityGroupGone(created.sg.groupId);
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 120000 },
);

test.provider(
  "updates only changed inline rules and repairs a missing rule before a noop deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const retained: SecurityGroupRuleData = {
        ipProtocol: "tcp",
        fromPort: 443,
        toPort: 443,
        cidrIpv4: "10.0.0.0/16",
      };
      const before: SecurityGroupRuleData = {
        ipProtocol: "tcp",
        fromPort: 22,
        toPort: 22,
        cidrIpv4: "10.0.0.0/16",
      };
      const after: SecurityGroupRuleData = {
        ipProtocol: "udp",
        fromPort: 53,
        toPort: 53,
        cidrIpv4: "10.1.0.0/16",
      };
      const makeStack = (rule: SecurityGroupRuleData) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("RuleDeltaVpc", { cidrBlock: "10.0.0.0/16" });
          const sg = yield* SecurityGroup("RuleDeltaSg", {
            vpcId: vpc.vpcId,
            ingress: [retained, rule],
            egress: [],
          });
          return { vpc, sg };
        });
      const created = yield* stack.deploy(makeStack(before));
      const readRules = () =>
        ec2.describeSecurityGroupRules({
          Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
        });
      const initial = yield* readRules();
      expect(initial.SecurityGroupRules).toHaveLength(2);
      const retainedRule = initial.SecurityGroupRules?.find(
        (rule) => rule.FromPort === 443,
      );
      const removedRule = initial.SecurityGroupRules?.find(
        (rule) => rule.FromPort === 22,
      );
      expect(retainedRule?.SecurityGroupRuleId).toMatch(/^sgr-/);
      expect(removedRule?.SecurityGroupRuleId).toMatch(/^sgr-/);
      const desiredStack = makeStack(after);
      const updatePlan = yield* stack.plan(desiredStack);
      expect(updatePlan.resources.RuleDeltaSg).toMatchObject({
        action: "update",
      });
      const updated = yield* stack.deploy(desiredStack);
      expect(updated.sg.groupId).toBe(created.sg.groupId);
      expect(updated.sg.groupArn).toBe(created.sg.groupArn);
      expect(updated.sg.ownerId).toBe(created.sg.ownerId);
      const changed = yield* readRules();
      expect(changed.SecurityGroupRules).toHaveLength(2);
      expect(changed.SecurityGroupRules).toEqual(
        expect.arrayContaining([
          retainedRule,
          expect.objectContaining({
            IsEgress: false,
            IpProtocol: "udp",
            FromPort: 53,
            ToPort: 53,
            CidrIpv4: "10.1.0.0/16",
          }),
        ]),
      );
      expect(
        changed.SecurityGroupRules?.some(
          (rule) =>
            rule.SecurityGroupRuleId === removedRule?.SecurityGroupRuleId,
        ),
      ).toBe(false);
      const addedRule = changed.SecurityGroupRules?.find(
        (rule) => rule.FromPort === 53,
      );
      expect(addedRule?.SecurityGroupRuleId).toMatch(/^sgr-/);
      yield* ec2.revokeSecurityGroupIngress({
        GroupId: created.sg.groupId,
        SecurityGroupRuleIds: [addedRule!.SecurityGroupRuleId!],
      });
      const drifted = yield* readRules().pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          times: 8,
          until: (response) =>
            response.SecurityGroupRules?.length === 1 &&
            response.SecurityGroupRules[0]?.SecurityGroupRuleId ===
              retainedRule?.SecurityGroupRuleId,
        }),
      );
      expect(drifted.SecurityGroupRules).toEqual([retainedRule]);
      const repairPlan = yield* stack.plan(desiredStack);
      expect(repairPlan.resources.RuleDeltaSg).toMatchObject({
        action: "update",
      });
      const repaired = yield* stack.deploy(desiredStack);
      expect(repaired.sg.groupId).toBe(created.sg.groupId);
      const restored = yield* readRules();
      expect(restored.SecurityGroupRules).toHaveLength(2);
      expect(restored.SecurityGroupRules).toEqual(
        expect.arrayContaining([
          retainedRule,
          expect.objectContaining({
            IsEgress: false,
            IpProtocol: "udp",
            FromPort: 53,
            ToPort: 53,
            CidrIpv4: "10.1.0.0/16",
          }),
        ]),
      );
      expect(
        restored.SecurityGroupRules?.some(
          (rule) => rule.SecurityGroupRuleId === addedRule?.SecurityGroupRuleId,
        ),
      ).toBe(false);
      const noopPlan = yield* stack.plan(desiredStack);
      expect(noopPlan.resources.RuleDeltaSg).toMatchObject({ action: "noop" });
      yield* stack.deploy(desiredStack);
      const unchanged = yield* readRules();
      expect(unchanged.SecurityGroupRules).toHaveLength(2);
      expect(unchanged.SecurityGroupRules).toEqual(
        expect.arrayContaining(restored.SecurityGroupRules ?? []),
      );
      yield* stack.destroy();
      yield* assertSecurityGroupGone(created.sg.groupId);
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 120000 },
);

test.provider(
  "canonical inline rules retain IDs across equivalent updates and noop deploys",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const supplied: SecurityGroupRuleData[] = [
        {
          ipProtocol: "6",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "100.68.0.18/18",
          cidrIpv6: "2001:DB8:0:0:ABCD:0123:4567:89ab/64",
          description: "",
        },
        {
          ipProtocol: "17",
          fromPort: 53,
          toPort: 53,
          cidrIpv4: "10.0.0.1/16",
        },
        {
          ipProtocol: "1",
          fromPort: 8,
          toPort: -1,
          cidrIpv4: "10.0.0.1/16",
        },
        {
          ipProtocol: "-1",
          fromPort: 0,
          toPort: 65535,
          cidrIpv4: "10.1.0.1/16",
        },
        {
          ipProtocol: "50",
          fromPort: 0,
          toPort: 65535,
          cidrIpv4: "10.2.0.1/16",
        },
        { ipProtocol: "icmpv6", cidrIpv6: "::/0" },
      ];
      const canonical: SecurityGroupRuleData[] = [
        {
          ipProtocol: "58",
          fromPort: -1,
          toPort: -1,
          cidrIpv6: "::/0",
        },
        { ipProtocol: "50", cidrIpv4: "10.2.0.0/16" },
        { ipProtocol: "-1", cidrIpv4: "10.1.0.0/16" },
        {
          ipProtocol: "icmp",
          fromPort: 8,
          toPort: -1,
          cidrIpv4: "10.0.0.0/16",
        },
        {
          ipProtocol: "udp",
          fromPort: 53,
          toPort: 53,
          cidrIpv4: "10.0.0.0/16",
        },
        {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv6: "2001:db8::/64",
        },
        {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "100.68.0.0/18",
        },
      ];
      const makeStack = (ingress: SecurityGroupRuleData[], label: string) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("CanonicalVpc", { cidrBlock: "10.0.0.0/16" });
          const sg = yield* SecurityGroup("CanonicalSg", {
            vpcId: vpc.vpcId,
            ingress,
            egress: [],
            tags: { Label: label },
          });
          return { vpc, sg };
        });
      const created = yield* stack.deploy(makeStack(supplied, "before"));
      const readRules = () =>
        ec2.describeSecurityGroupRules({
          Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
        });
      const initial = yield* readRules();
      expect(initial.SecurityGroupRules).toHaveLength(7);
      for (const rule of canonical) {
        expect(initial.SecurityGroupRules).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              IsEgress: false,
              IpProtocol:
                rule.ipProtocol === "58"
                  ? expect.stringMatching(/^(58|icmpv6)$/)
                  : rule.ipProtocol,
              ...(rule.fromPort === undefined
                ? {}
                : { FromPort: rule.fromPort }),
              ...(rule.toPort === undefined ? {} : { ToPort: rule.toPort }),
              ...(rule.cidrIpv4 === undefined
                ? {}
                : { CidrIpv4: rule.cidrIpv4 }),
              ...(rule.cidrIpv6 === undefined
                ? {}
                : { CidrIpv6: rule.cidrIpv6 }),
            }),
          ]),
        );
      }
      const originalPlan = yield* stack.plan(makeStack(supplied, "before"));
      expect(originalPlan.resources.CanonicalSg).toMatchObject({
        action: "noop",
      });

      const equivalentStack = makeStack(canonical, "after");
      const updated = yield* stack.deploy(equivalentStack);
      expect(updated.sg.groupId).toBe(created.sg.groupId);
      const equivalent = yield* readRules();
      expect(equivalent.SecurityGroupRules).toHaveLength(7);
      expect(equivalent.SecurityGroupRules).toEqual(
        expect.arrayContaining(initial.SecurityGroupRules ?? []),
      );
      const plan = yield* stack.plan(equivalentStack);
      expect(plan.resources.CanonicalSg).toMatchObject({ action: "noop" });
      yield* stack.deploy(equivalentStack);
      const unchanged = yield* readRules();
      expect(unchanged.SecurityGroupRules).toHaveLength(7);
      expect(unchanged.SecurityGroupRules).toEqual(
        expect.arrayContaining(initial.SecurityGroupRules ?? []),
      );
      yield* stack.destroy();
      yield* assertSecurityGroupGone(created.sg.groupId);
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 120000 },
);
