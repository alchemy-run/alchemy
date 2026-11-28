import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { Group, GroupProvider } from "@alchemy.run/aws/IAM/Group";
import { Policy, PolicyProvider, type PolicyDocument } from "@alchemy.run/aws/IAM/Policy";
import { User, UserProvider } from "@alchemy.run/aws/IAM/User";
import { describe, expect, it } from "@alchemy.run/test";
import { Credentials, type ResolvedCredentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { noopSession } from "alchemy/Report";
import { Stack, type StackSpec } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const accountId = "123456789012";
const region = "us-east-1";
const name = "Example";
const arn = `arn:aws:iam::${accountId}:policy/${name}` as const;
const resource = "arn:aws:s3:::example-bucket/*";
const stack: Omit<StackSpec, "output"> = {
  name: "iam-test",
  stage: "test",
  resources: {},
  bindings: {},
  actions: {},
};
const context = {
  id: name,
  fqn: name,
  instanceId: "0123456789abcdef0123456789abcdef",
  olds: undefined,
  output: undefined,
  session: noopSession,
  bindings: [],
};
const credentials = Effect.succeed<ResolvedCredentials>({
  accessKeyId: Redacted.make("AKIAIOSFODNN7EXAMPLE"),
  secretAccessKey: Redacted.make("fixture"),
  region,
  expiration: undefined,
  sessionToken: undefined,
});

const policy = (action: string): PolicyDocument => ({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Action: [action], Resource: resource }],
});

const policyWrites = ["CreatePolicyVersion", "PutUserPolicy", "PutGroupPolicy"];
const resourceXml = (kind: string) =>
  `<${kind}><Path>/</Path><${kind}Name>${name}</${kind}Name><${kind}Id>example-id</${kind}Id><Arn>arn:aws:iam::${accountId}:${kind.toLowerCase()}/${name}</Arn><CreateDate>2026-11-01T00:00:00Z</CreateDate></${kind}>`;
const tag = (key: string, value: string) =>
  `<member><Key>${key}</Key><Value>${value}</Value></member>`;
const tags = `<Tags>${tag("alchemy::id", name)}${tag("alchemy::stack", stack.name)}${tag("alchemy::stage", stack.stage)}</Tags>`;

// Exercise the providers through the real IAM query codec. The fixture has no
// network fallback or real credentials; unexpected IAM operations fail the test.
const fixture = (hasObservedDocument = true) => {
  const calls: URLSearchParams[] = [];
  let document = hasObservedDocument
    ? JSON.stringify({
        Statement: [{ Resource: resource, Action: "s3:GetObject", Effect: "Allow" }],
        Version: "2012-10-17",
      })
    : undefined;
  let version = "v1";
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body._tag !== "Uint8Array") throw new Error("Expected an IAM query body");
      const params = new URLSearchParams(new TextDecoder().decode(request.body.body));
      calls.push(params);
      const action = params.get("Action");
      let result = "";
      switch (action) {
        case "GetPolicy":
          result = `<Policy><PolicyName>${name}</PolicyName><Arn>${arn}</Arn><DefaultVersionId>${version}</DefaultVersionId></Policy>`;
          break;
        case "GetPolicyVersion":
          result = `<PolicyVersion><VersionId>${version}</VersionId>${document === undefined ? "" : `<Document>${encodeURIComponent(document)}</Document>`}<IsDefaultVersion>true</IsDefaultVersion></PolicyVersion>`;
          break;
        case "ListPolicyVersions":
          result =
            "<Versions><member><VersionId>v1</VersionId><IsDefaultVersion>true</IsDefaultVersion></member></Versions>";
          break;
        case "CreatePolicyVersion":
          version = "v2";
          document = params.get("PolicyDocument") ?? "";
          result =
            "<PolicyVersion><VersionId>v2</VersionId><IsDefaultVersion>true</IsDefaultVersion></PolicyVersion>";
          break;
        case "GetUser":
          result = resourceXml("User");
          break;
        case "GetGroup":
          result = resourceXml("Group") + "<Users/>";
          break;
        case "ListUserTags":
        case "ListPolicyTags":
          result = tags;
          break;
        case "ListAttachedUserPolicies":
        case "ListAttachedGroupPolicies":
          result = "<AttachedPolicies/>";
          break;
        case "ListUserPolicies":
        case "ListGroupPolicies":
          result =
            document === undefined
              ? "<PolicyNames/>"
              : `<PolicyNames><member>${name}</member></PolicyNames>`;
          break;
        case "GetUserPolicy":
        case "GetGroupPolicy": {
          if (document === undefined) throw new Error("No inline policy in fixture");
          const field = action === "GetUserPolicy" ? "UserName" : "GroupName";
          result = `<${field}>${name}</${field}><PolicyName>${name}</PolicyName><PolicyDocument>${encodeURIComponent(document)}</PolicyDocument>`;
          break;
        }
        case "PutUserPolicy":
        case "PutGroupPolicy":
          document = params.get("PolicyDocument") ?? "";
          break;
        case "SetDefaultPolicyVersion":
        case "TagPolicy":
        case "TagUser":
        case "AttachGroupPolicy":
          break;
        default:
          throw new Error(`Unexpected IAM action: ${action}`);
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          `<${action}Response xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><${action}Result>${result}</${action}Result><ResponseMetadata><RequestId>fixture</RequestId></ResponseMetadata></${action}Response>`,
          { headers: { "content-type": "text/xml" } },
        ),
      );
    }),
  );
  const environment = Layer.mergeAll(
    Layer.succeed(Credentials, credentials),
    Layer.succeed(AWSEnvironment, Effect.succeed({ accountId, region, credentials })),
    Layer.succeed(Region, Effect.succeed(region)),
    Layer.succeed(Stack, stack),
    Layer.succeed(Stage, stack.stage),
    NodeServices.layer,
    Layer.succeed(HttpClient.HttpClient, http),
  );
  return {
    calls,
    layer: Layer.mergeAll(PolicyProvider(), UserProvider(), GroupProvider()).pipe(
      Layer.provideMerge(environment),
    ),
  };
};

describe(
  "IAM policy reconciliation",
  { tags: ["unit", "provider:aws", "provider:aws:iam", "local"] },
  () => {
    const cases = [
      {
        name: "managed policy",
        reconcile: (document: PolicyDocument) =>
          Effect.gen(function* () {
            const provider = yield* Policy.Provider;
            yield* provider.reconcile({
              ...context,
              news: { policyName: name, policyDocument: document, tags: { env: "test" } },
            });
          }),
        write: "CreatePolicyVersion",
        independent: "TagPolicy",
      },
      {
        name: "user inline policy",
        reconcile: (document: PolicyDocument) =>
          Effect.gen(function* () {
            const provider = yield* User.Provider;
            yield* provider.reconcile({
              ...context,
              news: { userName: name, inlinePolicies: { [name]: document }, tags: { env: "test" } },
            });
          }),
        write: "PutUserPolicy",
        independent: "TagUser",
      },
      {
        name: "group inline policy",
        reconcile: (document: PolicyDocument) =>
          Effect.gen(function* () {
            const provider = yield* Group.Provider;
            yield* provider.reconcile({
              ...context,
              news: {
                groupName: name,
                inlinePolicies: { [name]: document },
                managedPolicyArns: [arn],
              },
            });
          }),
        write: "PutGroupPolicy",
        independent: "AttachGroupPolicy",
      },
    ];
    for (const { name, reconcile, write, independent } of cases) {
      it.effect(`writes ${name} when no document was observed`, () => {
        const { calls, layer } = fixture(false);
        return Effect.gen(function* () {
          yield* reconcile(policy("s3:GetObject"));
          expect(
            calls
              .map((params) => params.get("Action"))
              .filter((action) => action !== null && policyWrites.includes(action)),
          ).toEqual([write]);
        }).pipe(Effect.provide(layer));
      });

      it.effect(
        `does not rewrite an equivalent ${name}, but writes a changed document once`,
        () => {
          const { calls, layer } = fixture();
          return Effect.gen(function* () {
            yield* reconcile(policy("s3:GetObject"));
            const actions = calls.map((params) => params.get("Action"));
            expect(actions).toContain(independent);
            expect(
              actions.filter((action) => action !== null && policyWrites.includes(action)),
            ).toEqual([]);
            expect(actions).not.toContain("ListPolicyVersions");
            expect(actions).not.toContain("SetDefaultPolicyVersion");

            calls.length = 0;
            const changed = policy("s3:PutObject");
            yield* reconcile(changed);
            const writes = calls.filter((params) =>
              policyWrites.includes(params.get("Action") ?? ""),
            );
            expect(writes.map((params) => params.get("Action"))).toEqual([write]);
            expect(JSON.parse(writes[0]?.get("PolicyDocument") ?? "null")).toEqual(changed);
          }).pipe(Effect.provide(layer));
        },
      );
    }
  },
);
