// oxlint-disable sonarjs/no-nested-functions -- the fake client closes over per-test AWS state
import { AWSEnvironment } from "@/AWS";
import { Credentials } from "@/AWS/Credentials";
import {
  SecurityGroup,
  SecurityGroupId,
  SecurityGroupProvider,
  VpcId,
} from "@/AWS/EC2";
import * as Provider from "@/Provider";
import type { ScopedPlanStatusSession } from "@/Report.ts";
import { Stack } from "@/Stack";
import { Stage } from "@/Stage";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

type MockRule = {
  readonly cidrIpv4: string;
  readonly groupId: string;
  readonly groupOwnerId: string;
  readonly ipProtocol: string;
  readonly isEgress: boolean;
  readonly securityGroupRuleId: string;
  readonly tags: ReadonlyArray<{
    readonly key: string;
    readonly value: string;
  }>;
};

const groupId = SecurityGroupId("0123456789abcdef0");
const vpcId = VpcId("0123456789abcdef0");
const session: ScopedPlanStatusSession = {
  done: () => Effect.void,
  emit: () => Effect.void,
  note: () => Effect.void,
};

const rule = (
  securityGroupRuleId: string,
  isEgress: boolean,
  tags: MockRule["tags"] = [],
): MockRule => ({
  cidrIpv4: "10.0.0.0/16",
  groupId,
  groupOwnerId: "123456789012",
  ipProtocol: "tcp",
  isEgress,
  securityGroupRuleId,
  tags,
});

const xmlRule = (item: MockRule) => `
  <item>
    <securityGroupRuleId>${item.securityGroupRuleId}</securityGroupRuleId>
    <groupId>${item.groupId}</groupId>
    <groupOwnerId>${item.groupOwnerId}</groupOwnerId>
    <isEgress>${String(item.isEgress)}</isEgress>
    <ipProtocol>${item.ipProtocol}</ipProtocol>
    <cidrIpv4>${item.cidrIpv4}</cidrIpv4>
    <tagSet>${item.tags
      .map(
        ({ key, value }) =>
          `<item><key>${key}</key><value>${value}</value></item>`,
      )
      .join("")}</tagSet>
  </item>`;

const xmlResponse = (action: string, body: string) =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
     <${action}Response xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
       <requestId>test-request</requestId>${body}
     </${action}Response>`,
    { status: 200, headers: { "content-type": "application/xml" } },
  );

const requestParams = (body: HttpBody.HttpBody) =>
  body._tag === "Uint8Array"
    ? new URLSearchParams(new TextDecoder().decode(body.body))
    : new URLSearchParams();

const makeHarness = (initialRules: ReadonlyArray<MockRule>) => {
  const state = {
    authorizedEgress: 0,
    createdGroups: 0,
    revokedEgress: [] as string[],
    rules: [...initialRules],
  };

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const params = requestParams(request.body);
      const action = params.get("Action") ?? "Unknown";
      const revokeRules = (revoked: string[]) => {
        const ids = [...params.entries()]
          .filter(([key]) => key.startsWith("SecurityGroupRuleId."))
          .map(([, value]) => value);
        revoked.push(...ids);
        state.rules = state.rules.filter(
          ({ securityGroupRuleId }) => !ids.includes(securityGroupRuleId),
        );
        return "<return>true</return>";
      };

      let body = "<return>true</return>";
      if (action === "CreateSecurityGroup") {
        state.createdGroups += 1;
        state.rules.push(rule("sgr-aws-default", true));
        body = `<groupId>${groupId}</groupId>`;
      } else if (action === "DescribeSecurityGroups") {
        body = `<securityGroupInfo><item>
          <groupId>${groupId}</groupId><groupName>test-group</groupName>
          <groupDescription>test group</groupDescription>
          <ownerId>123456789012</ownerId><vpcId>${vpcId}</vpcId>
          <tagSet><item><key>alchemy::id</key><value>TestGroup</value></item></tagSet>
        </item></securityGroupInfo>`;
      } else if (action === "DescribeSecurityGroupRules") {
        body = `<securityGroupRuleSet>${state.rules.map(xmlRule).join("")}</securityGroupRuleSet>`;
      } else if (action === "RevokeSecurityGroupEgress") {
        body = revokeRules(state.revokedEgress);
      } else if (action === "AuthorizeSecurityGroupEgress") {
        state.authorizedEgress += 1;
        state.rules.push(
          rule(`sgr-authorized-${state.authorizedEgress}`, true),
        );
      }

      return HttpClientResponse.fromWeb(request, xmlResponse(action, body));
    }),
  );

  const credentials = Effect.succeed({
    accessKeyId: Redacted.make("AKIAIOSFODNN7EXAMPLE"),
    secretAccessKey: Redacted.make("test-secret-key"),
    sessionToken: undefined,
    region: "eu-central-1" as const,
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(Credentials, credentials),
    Layer.succeed(
      AWSEnvironment,
      Effect.succeed({
        accountId: "123456789012",
        credentials,
        region: "eu-central-1",
      }),
    ),
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(Stack, {
      actions: {},
      bindings: {},
      name: "provider-test",
      resources: {},
      stage: "test",
    }),
    Layer.succeed(Stage, "test"),
  );
  const providers = SecurityGroupProvider().pipe(
    Layer.provideMerge(dependencies),
  );

  const reconcile = (egress: [] | undefined, update: boolean) =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(SecurityGroup);
      return yield* provider.reconcile({
        bindings: [],
        fqn: "TestGroup",
        id: "TestGroup",
        instanceId: "test-instance",
        news: {
          description: "test group",
          groupName: "test-group",
          vpcId,
          ...(egress === undefined ? {} : { egress }),
        },
        olds: update ? { vpcId } : undefined,
        output: update
          ? {
              description: "test group",
              groupArn:
                "arn:aws:ec2:eu-central-1:123456789012:security-group/sg-0123456789abcdef0",
              groupId,
              groupName: "test-group",
              ownerId: "123456789012",
              vpcId,
            }
          : undefined,
        session,
      });
    }).pipe(Effect.provide(providers));

  return { reconcile, state };
};

describe("SecurityGroup provider reconciliation", () => {
  it.effect("keeps explicit empty egress empty during create", () => {
    const { reconcile, state } = makeHarness([]);
    return Effect.gen(function* () {
      yield* reconcile([], false);
      expect(state.createdGroups).toBe(1);
      expect(state.revokedEgress).toEqual(["sgr-aws-default"]);
      expect(state.authorizedEgress).toBe(0);
    });
  });

  it.effect(
    "restores default egress when egress is omitted during update",
    () => {
      const { reconcile, state } = makeHarness([]);
      return Effect.gen(function* () {
        yield* reconcile(undefined, true);
        expect(state.authorizedEgress).toBe(1);
      });
    },
  );
});
