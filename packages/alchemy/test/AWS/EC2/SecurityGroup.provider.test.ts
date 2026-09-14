import {
  SecurityGroup,
  SecurityGroupProvider,
  type SecurityGroupProps,
} from "@/AWS/EC2/SecurityGroup.ts";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import * as Provider from "@/Provider.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { Credentials, fromCredentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const groupId = "sg-0123456789abcdef0";
const vpcId = "vpc-0123456789abcdef0";
const instanceId = "0123456789abcdef0123456789abcdef";
const props: SecurityGroupProps = { vpcId, groupName: "provider-test" };
const output: SecurityGroup["Attributes"] = {
  groupId,
  groupArn: `arn:aws:ec2:us-east-1:123456789012:security-group/${groupId}`,
  groupName: "provider-test",
  description: "Managed by Alchemy",
  vpcId,
  ownerId: "123456789012",
};
const session = {
  emit: () => Effect.void,
  done: () => Effect.void,
  note: () => Effect.void,
};

const groupXml = `<securityGroupInfo><item>
  <groupId>${groupId}</groupId><groupName>provider-test</groupName>
  <groupDescription>Managed by Alchemy</groupDescription>
  <vpcId>${vpcId}</vpcId><ownerId>123456789012</ownerId>
  <tagSet>
    <item><key>Name</key><value>Group</value></item>
    <item><key>alchemy::id</key><value>Group</value></item>
    <item><key>alchemy::stack</key><value>SecurityGroupProvider</value></item>
    <item><key>alchemy::stage</key><value>test</value></item>
  </tagSet>
</item></securityGroupInfo>`;
const defaultEgressXml = `<item>
  <securityGroupRuleId>sgr-default</securityGroupRuleId>
  <groupId>${groupId}</groupId><isEgress>true</isEgress>
  <ipProtocol>-1</ipProtocol><cidrIpv4>0.0.0.0/0</cidrIpv4>
</item>`;
const httpsEgressXml = `<item>
  <securityGroupRuleId>sgr-https</securityGroupRuleId>
  <groupId>${groupId}</groupId><isEgress>true</isEgress>
  <ipProtocol>tcp</ipProtocol><fromPort>443</fromPort><toPort>443</toPort>
  <cidrIpv4>0.0.0.0/0</cidrIpv4>
</item>`;
const sshIngressXml = `<item>
  <securityGroupRuleId>sgr-standalone</securityGroupRuleId>
  <groupId>${groupId}</groupId><isEgress>false</isEgress>
  <ipProtocol>tcp</ipProtocol><fromPort>22</fromPort><toPort>22</toPort>
  <cidrIpv4>10.0.0.0/16</cidrIpv4>
</item>`;

interface Call {
  action: string;
  params: URLSearchParams;
}
interface ResponseBody {
  xml: string;
  status?: number;
}

// Exercise the real distilled request encoder, signer, and response decoder.
// The only substituted service is HTTP; these credentials cannot access AWS.
const credentials = fromCredentials(
  { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "test-secret" },
  "us-east-1",
);
const environment = Layer.mergeAll(
  Layer.effect(
    AWSEnvironment,
    Effect.map(Credentials, (credentials) =>
      Effect.succeed({
        accountId: "123456789012",
        region: "us-east-1",
        credentials,
      }),
    ),
  ).pipe(Layer.provide(credentials)),
  credentials,
  Layer.succeed(Region, Effect.succeed("us-east-1")),
  Layer.succeed(Stack, {
    name: "SecurityGroupProvider",
    stage: "test",
    resources: {},
    bindings: {},
    actions: {},
  }),
  Layer.succeed(Stage, "test"),
);

const withProvider = <A, E, R>(
  respond: (call: Call, calls: readonly Call[]) => ResponseBody,
  run: (
    provider: Provider.ProviderService<SecurityGroup>,
    calls: readonly Call[],
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const calls: Call[] = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag !== "Uint8Array") {
          throw new Error(`Unexpected EC2 request body: ${request.body._tag}`);
        }
        const params = new URLSearchParams(
          new TextDecoder().decode(request.body.body),
        );
        const action = params.get("Action");
        if (action === null) throw new Error("EC2 request has no Action");
        const call = { action, params };
        calls.push(call);
        const result = respond(call, calls);
        const body = result.status
          ? result.xml
          : `<${action}Response xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
              <requestId>request-1</requestId>${result.xml}
            </${action}Response>`;
        return HttpClientResponse.fromWeb(
          request,
          new Response(body, {
            status: result.status ?? 200,
            headers: { "content-type": "text/xml" },
          }),
        );
      }),
    );
    return yield* Effect.gen(function* () {
      const provider = yield* Provider.findProvider(SecurityGroup);
      return yield* run(provider, calls);
    }).pipe(
      Effect.provide(SecurityGroupProvider()),
      Effect.provide(environment),
      Effect.provideService(HttpClient.HttpClient, http),
    );
  });

const reconcile = (
  provider: Provider.ProviderService<SecurityGroup>,
  news: SecurityGroupProps,
  previous: { output: SecurityGroup["Attributes"] | undefined } = { output },
) =>
  provider.reconcile({
    id: "Group",
    fqn: "Group",
    instanceId,
    news,
    olds: previous.output === undefined ? undefined : props,
    output: previous.output,
    bindings: [],
    session,
  });

const lifecycleResponse =
  (finalRules: string) =>
  (call: Call, calls: readonly Call[]): ResponseBody => {
    switch (call.action) {
      case "CreateSecurityGroup":
        return { xml: `<groupId>${groupId}</groupId>` };
      case "DescribeSecurityGroups":
        return { xml: groupXml };
      case "DescribeSecurityGroupRules":
        return {
          xml: `<securityGroupRuleSet>${
            calls.filter((call) => call.action === "DescribeSecurityGroupRules")
              .length === 1
              ? defaultEgressXml
              : finalRules
          }</securityGroupRuleSet>`,
        };
      case "AuthorizeSecurityGroupEgress":
      case "RevokeSecurityGroupEgress":
        return { xml: "<return>true</return>" };
      default:
        throw new Error(`Unexpected EC2 operation: ${call.action}`);
    }
  };

const observedRules =
  (rules: string) =>
  (call: Call): ResponseBody => {
    switch (call.action) {
      case "DescribeSecurityGroups":
        return { xml: groupXml };
      case "DescribeSecurityGroupRules":
        return { xml: `<securityGroupRuleSet>${rules}</securityGroupRuleSet>` };
      default:
        throw new Error(`Unchanged rules must not be changed: ${call.action}`);
    }
  };

const diff = (
  provider: Provider.ProviderService<SecurityGroup>,
  news: SecurityGroupProps,
) =>
  provider.diff!({
    id: "Group",
    fqn: "Group",
    instanceId,
    news,
    olds: news,
    output,
    oldBindings: [],
    newBindings: [],
  });

describe("SecurityGroup egress defaults", () => {
  for (const phase of ["create", "update"] as const) {
    it.effect(`honors an empty egress array on ${phase}`, () =>
      withProvider(lifecycleResponse(""), (provider, calls) =>
        Effect.gen(function* () {
          const result = yield* reconcile(
            provider,
            { ...props, egress: [] },
            { output: phase === "create" ? undefined : output },
          );
          expect(calls.map((call) => call.action)).toContain(
            "RevokeSecurityGroupEgress",
          );
          expect(calls.map((call) => call.action)).not.toContain(
            "AuthorizeSecurityGroupEgress",
          );
          expect(result.egressRules).toEqual([]);
        }),
      ),
    );
  }

  it.effect("keeps the default IPv4 egress when omitted", () =>
    withProvider(lifecycleResponse(defaultEgressXml), (provider) =>
      Effect.gen(function* () {
        const result = yield* reconcile(provider, props);
        expect(result.egressRules).toEqual([
          expect.objectContaining({ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }),
        ]);
      }),
    ),
  );

  it.effect("applies explicitly configured egress", () =>
    withProvider(lifecycleResponse(httpsEgressXml), (provider, calls) =>
      Effect.gen(function* () {
        yield* reconcile(provider, {
          ...props,
          egress: [
            {
              ipProtocol: "tcp",
              fromPort: 443,
              toPort: 443,
              cidrIpv4: "0.0.0.0/0",
            },
          ],
        });
        const authorized = calls.filter(
          (call) => call.action === "AuthorizeSecurityGroupEgress",
        );
        expect(authorized).toHaveLength(1);
        expect(authorized[0]!.params.get("IpPermissions.1.IpProtocol")).toBe(
          "tcp",
        );
        expect(authorized[0]!.params.get("IpPermissions.1.FromPort")).toBe(
          "443",
        );
      }),
    ),
  );
});

describe("SecurityGroup rule settlement", () => {
  it.live(
    "waits for revoked rules to disappear without repeating writes",
    () =>
      withProvider(
        (call, calls) => {
          if (call.action === "RevokeSecurityGroupEgress")
            return { xml: "<return>true</return>" };
          const reads = calls.filter(
            (call) => call.action === "DescribeSecurityGroupRules",
          ).length;
          return observedRules(reads < 3 ? defaultEgressXml : "")(call);
        },
        (provider, calls) =>
          Effect.gen(function* () {
            const result = yield* reconcile(provider, {
              ...props,
              egress: [],
            });
            expect(result.egressRules).toEqual([]);
            expect(
              calls.filter(
                (call) => call.action === "RevokeSecurityGroupEgress",
              ),
            ).toHaveLength(1);
            expect(
              calls.filter(
                (call) => call.action === "DescribeSecurityGroupRules",
              ),
            ).toHaveLength(3);
          }),
      ),
    { timeout: 30000 },
  );

  it.live(
    "fails a persistently unsettled rule set within the observation budget",
    () =>
      withProvider(
        (call) =>
          call.action === "RevokeSecurityGroupEgress"
            ? { xml: "<return>true</return>" }
            : observedRules(defaultEgressXml)(call),
        (provider, calls) =>
          Effect.gen(function* () {
            const error = yield* reconcile(provider, {
              ...props,
              egress: [],
            }).pipe(Effect.flip);
            expect(error._tag).toBe("SecurityGroupRulesNotSettled");
            expect(error.groupId).toBe(groupId);
            expect(
              calls.filter(
                (call) => call.action === "RevokeSecurityGroupEgress",
              ),
            ).toHaveLength(1);
            expect(
              calls.filter(
                (call) => call.action === "DescribeSecurityGroupRules",
              ).length,
            ).toBeLessThanOrEqual(10);
          }),
      ),
    { timeout: 30000 },
  );

  it.effect(
    "propagates an observation authorization failure without retry",
    () =>
      withProvider(
        (call, calls) => {
          if (call.action === "RevokeSecurityGroupEgress")
            return { xml: "<return>true</return>" };
          if (
            call.action === "DescribeSecurityGroupRules" &&
            calls.filter((call) => call.action === "DescribeSecurityGroupRules")
              .length > 1
          ) {
            return {
              status: 403,
              xml: "<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>Access denied</Message></Error></Errors><RequestID>request-denied</RequestID></Response>",
            };
          }
          return observedRules(defaultEgressXml)(call);
        },
        (provider, calls) =>
          Effect.gen(function* () {
            const error = yield* reconcile(provider, {
              ...props,
              egress: [],
            }).pipe(Effect.flip);
            expect(error._tag).toBe("UnauthorizedOperation");
            expect(
              calls.filter(
                (call) => call.action === "DescribeSecurityGroupRules",
              ),
            ).toHaveLength(2);
          }),
      ),
    { timeout: 5000 },
  );
});

describe("SecurityGroup rule ownership", () => {
  it.effect("preserves standalone ingress and egress when omitted", () =>
    withProvider(
      observedRules(sshIngressXml + httpsEgressXml),
      (provider, calls) =>
        Effect.gen(function* () {
          const result = yield* reconcile(provider, props);
          expect(result.ingressRules?.[0]?.securityGroupRuleId).toBe(
            "sgr-standalone",
          );
          expect(result.egressRules?.[0]?.securityGroupRuleId).toBe(
            "sgr-https",
          );
          expect(
            calls.every((call) => call.action.startsWith("Describe")),
          ).toBe(true);
        }),
    ),
  );

  it.effect("preserves the native IPv6 default when egress is omitted", () =>
    withProvider(
      observedRules(
        defaultEgressXml +
          defaultEgressXml
            .replace("sgr-default", "sgr-ipv6")
            .replace(
              "<cidrIpv4>0.0.0.0/0</cidrIpv4>",
              "<cidrIpv6>::/0</cidrIpv6>",
            ),
      ),
      (provider) =>
        Effect.gen(function* () {
          const result = yield* reconcile(provider, props);
          expect(result.egressRules).toHaveLength(2);
          expect(result.egressRules?.[1]?.cidrIpv6).toBe("::/0");
        }),
    ),
  );

  it.effect("keeps empty explicitly managed directions empty", () =>
    withProvider(observedRules(""), (provider, calls) =>
      Effect.gen(function* () {
        const result = yield* reconcile(provider, {
          ...props,
          ingress: [],
          egress: [],
        });
        expect(result.ingressRules).toEqual([]);
        expect(result.egressRules).toEqual([]);
        expect(calls.every((call) => call.action.startsWith("Describe"))).toBe(
          true,
        );
      }),
    ),
  );
});

describe("SecurityGroup rule drift", () => {
  const cases: Array<{
    name: string;
    desired: NonNullable<SecurityGroupProps["ingress"]>;
    observed: string;
  }> = [
    {
      name: "IPv4 host bits",
      desired: [
        {
          ipProtocol: "tcp",
          fromPort: 22,
          toPort: 22,
          cidrIpv4: "100.68.0.18/18",
        },
      ],
      observed: sshIngressXml.replace("10.0.0.0/16", "100.68.0.0/18"),
    },
    {
      name: "IPv6 host bits and compression",
      desired: [
        {
          ipProtocol: "tcp",
          fromPort: 22,
          toPort: 22,
          cidrIpv6: "2001:DB8:0:0:ABCD:0123:4567:89ab/64",
        },
      ],
      observed: sshIngressXml.replace(
        "<cidrIpv4>10.0.0.0/16</cidrIpv4>",
        "<cidrIpv6>2001:db8::/64</cidrIpv6>",
      ),
    },
    {
      name: "IPv4-mapped IPv6 notation",
      desired: [
        {
          ipProtocol: "tcp",
          fromPort: 22,
          toPort: 22,
          cidrIpv6: "::ffff:192.0.2.128/120",
        },
      ],
      observed: sshIngressXml.replace(
        "<cidrIpv4>10.0.0.0/16</cidrIpv4>",
        "<cidrIpv6>::ffff:c000:200/120</cidrIpv6>",
      ),
    },
    {
      name: "TCP protocol numbers and empty descriptions",
      desired: [
        {
          ipProtocol: "6",
          fromPort: 22,
          toPort: 22,
          cidrIpv4: "10.0.0.0/16",
          description: "",
        },
      ],
      observed: sshIngressXml,
    },
    {
      name: "UDP protocol names",
      desired: [
        {
          ipProtocol: "udp",
          fromPort: 22,
          toPort: 22,
          cidrIpv4: "10.0.0.0/16",
        },
      ],
      observed: sshIngressXml.replace(
        "<ipProtocol>tcp</ipProtocol>",
        "<ipProtocol>17</ipProtocol>",
      ),
    },
    {
      name: "ICMP protocol names",
      desired: [
        {
          ipProtocol: "icmp",
          fromPort: 8,
          toPort: -1,
          cidrIpv4: "10.0.0.0/16",
        },
      ],
      observed: sshIngressXml
        .replace("<ipProtocol>tcp</ipProtocol>", "<ipProtocol>1</ipProtocol>")
        .replace(
          "<fromPort>22</fromPort><toPort>22</toPort>",
          "<fromPort>8</fromPort><toPort>-1</toPort>",
        ),
    },
    {
      name: "all-protocol ignored ports",
      desired: [
        {
          ipProtocol: "-1",
          fromPort: 0,
          toPort: 65535,
          cidrIpv4: "10.0.0.0/16",
        },
      ],
      observed: sshIngressXml
        .replace("<ipProtocol>tcp</ipProtocol>", "<ipProtocol>-1</ipProtocol>")
        .replace("<fromPort>22</fromPort><toPort>22</toPort>", ""),
    },
    {
      name: "ESP ignored ports",
      desired: [
        {
          ipProtocol: "50",
          fromPort: 0,
          toPort: 65535,
          cidrIpv4: "10.0.0.0/16",
        },
      ],
      observed: sshIngressXml
        .replace("<ipProtocol>tcp</ipProtocol>", "<ipProtocol>50</ipProtocol>")
        .replace("<fromPort>22</fromPort><toPort>22</toPort>", ""),
    },
    {
      name: "ICMPv6 omitted type and code",
      desired: [{ ipProtocol: "icmpv6", cidrIpv6: "::/0" }],
      observed: sshIngressXml
        .replace("<ipProtocol>tcp</ipProtocol>", "<ipProtocol>58</ipProtocol>")
        .replace(
          "<fromPort>22</fromPort><toPort>22</toPort>",
          "<fromPort>-1</fromPort><toPort>-1</toPort>",
        )
        .replace(
          "<cidrIpv4>10.0.0.0/16</cidrIpv4>",
          "<cidrIpv6>::/0</cidrIpv6>",
        ),
    },
    {
      name: "expanded source kinds and rule order",
      desired: [
        {
          ipProtocol: "tcp",
          fromPort: 22,
          toPort: 22,
          cidrIpv4: "10.0.0.0/16",
          cidrIpv6: "::/0",
          referencedGroupId: "sg-peer",
          prefixListId: "pl-peer",
        },
      ],
      observed: [
        sshIngressXml
          .replace("sgr-standalone", "sgr-prefix")
          .replace(
            "<cidrIpv4>10.0.0.0/16</cidrIpv4>",
            "<prefixListId>pl-peer</prefixListId>",
          ),
        sshIngressXml
          .replace("sgr-standalone", "sgr-group")
          .replace(
            "<cidrIpv4>10.0.0.0/16</cidrIpv4>",
            "<referencedGroupInfo><groupId>sg-peer</groupId><userId>123456789012</userId><vpcId>vpc-other</vpcId></referencedGroupInfo>",
          ),
        sshIngressXml
          .replace("sgr-standalone", "sgr-ipv6")
          .replace(
            "<cidrIpv4>10.0.0.0/16</cidrIpv4>",
            "<cidrIpv6>::/0</cidrIpv6>",
          ),
        sshIngressXml,
      ].join(""),
    },
  ];
  for (const scenario of cases) {
    it.effect(`recognizes equivalent ${scenario.name}`, () =>
      withProvider(observedRules(scenario.observed), (provider, calls) =>
        Effect.gen(function* () {
          const news = { ...props, ingress: scenario.desired };
          expect(yield* diff(provider, news)).toBeUndefined();
          yield* reconcile(provider, news);
          expect(
            calls.every((call) => call.action.startsWith("Describe")),
          ).toBe(true);
        }),
      ),
    );
  }

  for (const [name, observed] of [
    ["missing rule", ""],
    ["changed port", sshIngressXml.replaceAll(">22<", ">23<")],
    ["changed CIDR", sshIngressXml.replace("10.0.0.0/16", "10.1.0.0/16")],
    [
      "changed protocol",
      sshIngressXml.replace(
        "<ipProtocol>tcp</ipProtocol>",
        "<ipProtocol>udp</ipProtocol>",
      ),
    ],
    [
      "changed description",
      sshIngressXml.replace(
        "</item>",
        "<description>changed</description></item>",
      ),
    ],
    [
      "missing source metadata",
      sshIngressXml.replace("<cidrIpv4>10.0.0.0/16</cidrIpv4>", ""),
    ],
    [
      "missing direction metadata",
      sshIngressXml.replace("<isEgress>false</isEgress>", ""),
    ],
    [
      "missing protocol metadata",
      sshIngressXml.replace("<ipProtocol>tcp</ipProtocol>", ""),
    ],
    [
      "missing port metadata",
      sshIngressXml.replace("<fromPort>22</fromPort>", ""),
    ],
    [
      "additional rule",
      sshIngressXml +
        sshIngressXml
          .replace("sgr-standalone", "sgr-extra")
          .replaceAll(">22<", ">23<"),
    ],
  ]) {
    it.effect(`plans an update for ${name} with unchanged props`, () =>
      withProvider(observedRules(observed!), (provider, calls) =>
        Effect.gen(function* () {
          expect(
            yield* diff(provider, {
              ...props,
              ingress: [
                {
                  ipProtocol: "tcp",
                  fromPort: 22,
                  toPort: 22,
                  cidrIpv4: "10.0.0.0/16",
                },
              ],
            }),
          ).toEqual({ action: "update" });
          expect(provider.stables).toEqual(["groupId", "groupArn", "ownerId"]);
          expect(calls[0]!.params.get("GroupId.1")).toBe(groupId);
        }),
      ),
    );
  }

  for (const [name, rule, observed] of [
    [
      "IPv4 prefix",
      { ipProtocol: "tcp", fromPort: 22, toPort: 22, cidrIpv4: "10.0.0.0/33" },
      sshIngressXml.replace("10.0.0.0/16", "10.0.0.0/33"),
    ],
    [
      "IPv6 prefix",
      {
        ipProtocol: "tcp",
        fromPort: 22,
        toPort: 22,
        cidrIpv6: "2001:db8::/129",
      },
      sshIngressXml.replace(
        "<cidrIpv4>10.0.0.0/16</cidrIpv4>",
        "<cidrIpv6>2001:db8::/129</cidrIpv6>",
      ),
    ],
    [
      "protocol",
      {
        ipProtocol: "constructor",
        fromPort: 22,
        toPort: 22,
        cidrIpv4: "10.0.0.0/16",
      },
      sshIngressXml.replace(
        "<ipProtocol>tcp</ipProtocol>",
        "<ipProtocol>constructor</ipProtocol>",
      ),
    ],
  ] as const) {
    it.effect(
      `does not treat malformed ${name} as a settled configuration`,
      () =>
        withProvider(observedRules(observed), (provider, calls) =>
          Effect.gen(function* () {
            const news = { ...props, ingress: [rule] };
            expect(yield* diff(provider, news)).toEqual({ action: "update" });
            const error = yield* reconcile(provider, news).pipe(Effect.flip);
            expect(error._tag).toBe("InvalidSecurityGroupRules");
            expect(
              calls.every((call) => call.action.startsWith("Describe")),
            ).toBe(true);
          }),
        ),
    );
  }

  it.effect("reconciles only the changed rules", () => {
    const retained = sshIngressXml.replaceAll(">22<", ">443<");
    const added = sshIngressXml
      .replace("sgr-standalone", "sgr-postgres")
      .replaceAll(">22<", ">5432<");
    return withProvider(
      (call, calls) => {
        if (call.action === "DescribeSecurityGroupRules") {
          const modified = calls.some(
            (call) => call.action === "AuthorizeSecurityGroupIngress",
          );
          return {
            xml: `<securityGroupRuleSet>${retained}${modified ? added : sshIngressXml.replace("sgr-standalone", "sgr-remove")}</securityGroupRuleSet>`,
          };
        }
        if (
          call.action === "RevokeSecurityGroupIngress" ||
          call.action === "AuthorizeSecurityGroupIngress"
        )
          return { xml: "<return>true</return>" };
        return observedRules("")(call);
      },
      (provider, calls) =>
        Effect.gen(function* () {
          const news = {
            ...props,
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 443,
                toPort: 443,
                cidrIpv4: "10.0.0.0/16",
              },
              {
                ipProtocol: "tcp",
                fromPort: 5432,
                toPort: 5432,
                cidrIpv4: "10.0.0.0/16",
              },
            ],
          };
          const result = yield* reconcile(provider, news);
          const revoke = calls.find(
            (call) => call.action === "RevokeSecurityGroupIngress",
          )!;
          expect(revoke.params.get("SecurityGroupRuleId.1")).toBe("sgr-remove");
          expect(revoke.params.has("SecurityGroupRuleId.2")).toBe(false);
          const authorize = calls.find(
            (call) => call.action === "AuthorizeSecurityGroupIngress",
          )!;
          expect(authorize.params.get("IpPermissions.1.FromPort")).toBe("5432");
          expect(authorize.params.has("IpPermissions.2.IpProtocol")).toBe(
            false,
          );
          expect(
            result.ingressRules?.find((rule) => rule.fromPort === 443)
              ?.securityGroupRuleId,
          ).toBe("sgr-standalone");
          const before = calls.length;
          yield* reconcile(provider, news);
          expect(
            calls
              .slice(before)
              .every((call) => call.action.startsWith("Describe")),
          ).toBe(true);
        }),
    );
  });

  it.effect("updates descriptions without replacing rule IDs", () =>
    withProvider(
      (call, calls) => {
        if (call.action === "ModifySecurityGroupRules")
          return { xml: "<return>true</return>" };
        const changed = calls.some(
          (call) => call.action === "ModifySecurityGroupRules",
        );
        return observedRules(
          sshIngressXml.replace(
            "</item>",
            `<description>${changed ? "new" : "old"}</description></item>`,
          ),
        )(call);
      },
      (provider, calls) =>
        Effect.gen(function* () {
          const result = yield* reconcile(provider, {
            ...props,
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 22,
                toPort: 22,
                cidrIpv4: "10.0.0.0/16",
                description: "new",
              },
            ],
          });
          expect(
            calls
              .filter((call) => !call.action.startsWith("Describe"))
              .map((call) => call.action),
          ).toEqual(["ModifySecurityGroupRules"]);
          const modified = calls.find(
            (call) => call.action === "ModifySecurityGroupRules",
          )!;
          expect(
            modified.params.get("SecurityGroupRule.1.SecurityGroupRuleId"),
          ).toBe("sgr-standalone");
          expect(
            modified.params.get(
              "SecurityGroupRule.1.SecurityGroupRule.Description",
            ),
          ).toBe("new");
          expect(result.ingressRules?.[0]?.securityGroupRuleId).toBe(
            "sgr-standalone",
          );
        }),
    ),
  );

  it.effect(
    "invalidates stable IDs only when the physical group is missing",
    () =>
      withProvider(
        () => ({ xml: "<securityGroupInfo/>" }),
        (provider) =>
          Effect.gen(function* () {
            expect(yield* diff(provider, { ...props, ingress: [] })).toEqual({
              action: "update",
              stables: [],
            });
          }),
      ),
  );
});
