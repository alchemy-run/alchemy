/**
 * Offline coverage for `AWS.Lambda.Function`'s precreate failure cleanup.
 *
 * Precreate creates the execution role and `/aws/lambda/<name>` log group
 * before the function exists. A failure after that point records no
 * Attributes, so destroy's recovery `read` finds no function and drops the
 * row — the role and log group must not outlive the failed precreate. These
 * tests drive the provider against an in-memory IAM + Lambda + Logs fake, so
 * they pin the exact requests without a cloud account.
 */
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Lambda from "@alchemy.run/aws/Lambda";
import { Docker } from "@alchemy.run/docker/Docker";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { mock as mockCredentials } from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import * as Provider from "alchemy/Provider";
import { noopSession } from "alchemy/Report";
import { ResourceContext } from "alchemy/ResourceContext";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";

const ACCOUNT_ID = "123456789012";

/** In-memory IAM + Lambda + Logs account served over a fake HTTP client. */
const makeCloud = (
  options: {
    failCreateFunction?: boolean;
    createFunctionBeforeFailure?: boolean;
    omitLogGroupTags?: boolean;
    failDeleteRole?: boolean;
    omitRoleTags?: boolean;
  } = {},
) => {
  /** Attached managed policy ARNs per role. */
  const roles = new Map<string, Set<string>>();
  const roleTags = new Map<string, Record<string, string>>();
  const inlinePolicies = new Map<string, Map<string, string>>();
  const functions = new Set<string>();
  /** Log group name -> tags. */
  const logGroups = new Map<string, Record<string, string>>();
  const requests: string[] = [];
  const createFunctionBodies: Array<Record<string, unknown>> = [];

  const xml = (body: string, status = 200) =>
    new Response(body, { status, headers: { "content-type": "text/xml" } });
  const iamXml = (action: string, result = "") =>
    xml(
      `<${action}Response xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><${action}Result>${result}</${action}Result><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></${action}Response>`,
    );
  const iamError = (code: string, message: string, status = 404) =>
    xml(
      `<ErrorResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error><RequestId>r</RequestId></ErrorResponse>`,
      status,
    );
  const roleXml = (roleName: string) => {
    const tags = roleTags.get(roleName) ?? {};
    const tagXml = Object.entries(tags)
      .map(([Key, Value]) => `<member><Key>${Key}</Key><Value>${Value}</Value></member>`)
      .join("");
    return `<Role><Path>/</Path><RoleName>${roleName}</RoleName><RoleId>AROATEST</RoleId><Arn>arn:aws:iam::${ACCOUNT_ID}:role/${roleName}</Arn><CreateDate>2026-01-01T00:00:00Z</CreateDate>${tagXml === "" ? "" : `<Tags>${tagXml}</Tags>`}</Role>`;
  };

  const handleIam = (params: URLSearchParams) => {
    const action = params.get("Action")!;
    const roleName = params.get("RoleName") ?? "";
    const policies = roles.get(roleName);
    if (action !== "CreateRole" && policies === undefined) {
      return iamError("NoSuchEntity", "not found");
    }
    switch (action) {
      case "GetRole":
        return iamXml(action, roleXml(roleName));
      case "CreateRole": {
        roles.set(roleName, new Set());
        inlinePolicies.set(roleName, new Map());
        const tags: Record<string, string> = {};
        if (!options.omitRoleTags) {
          for (let i = 1; ; i++) {
            const key = params.get(`Tags.member.${i}.Key`);
            if (key === null) break;
            tags[key] = params.get(`Tags.member.${i}.Value`) ?? "";
          }
        }
        roleTags.set(roleName, tags);
        return iamXml(action, roleXml(roleName));
      }
      case "GetRolePolicy": {
        const policy = inlinePolicies.get(roleName)?.get(params.get("PolicyName")!);
        return policy === undefined
          ? iamError("NoSuchEntity", "not found")
          : iamXml(action, `<PolicyDocument>${encodeURIComponent(policy)}</PolicyDocument>`);
      }
      case "PutRolePolicy":
        inlinePolicies.get(roleName)!.set(params.get("PolicyName")!, params.get("PolicyDocument")!);
        return iamXml(action);
      case "ListRolePolicies":
        return iamXml(
          action,
          `<PolicyNames>${[...inlinePolicies.get(roleName)!.keys()].map((name) => `<member>${name}</member>`).join("")}</PolicyNames><IsTruncated>false</IsTruncated>`,
        );
      case "DeleteRolePolicy":
        inlinePolicies.get(roleName)!.delete(params.get("PolicyName")!);
        return iamXml(action);
      case "AttachRolePolicy":
        policies!.add(params.get("PolicyArn")!);
        return iamXml(action);
      case "DetachRolePolicy":
        policies!.delete(params.get("PolicyArn")!);
        return iamXml(action);
      case "ListAttachedRolePolicies":
        return iamXml(
          action,
          `<AttachedPolicies>${[...policies!]
            .map(
              (arn) =>
                `<member><PolicyName>${arn.split("/").pop()}</PolicyName><PolicyArn>${arn}</PolicyArn></member>`,
            )
            .join("")}</AttachedPolicies><IsTruncated>false</IsTruncated>`,
        );
      case "DeleteRole":
        if (options.failDeleteRole) {
          return iamError("AccessDenied", "cleanup exploded", 403);
        }
        if (policies!.size !== 0 || inlinePolicies.get(roleName)!.size !== 0) {
          throw new Error(`role ${roleName} still has policies`);
        }
        roles.delete(roleName);
        roleTags.delete(roleName);
        inlinePolicies.delete(roleName);
        return iamXml(action);
      default:
        throw new Error(`unexpected IAM action ${action}`);
    }
  };

  const lambdaJson = (status: number, body: unknown, errorType?: string) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        ...(errorType ? { "x-amzn-errortype": errorType } : {}),
      },
    });

  const handleLambda = (method: string, pathname: string, body: string) => {
    if (method === "POST" && pathname === "/2015-03-31/functions") {
      const request = JSON.parse(body) as Record<string, unknown>;
      createFunctionBodies.push(request);
      if (options.createFunctionBeforeFailure) functions.add(request.FunctionName as string);
      if (options.failCreateFunction) {
        return lambdaJson(400, { message: "stub rejected" }, "InvalidParameterValueException");
      }
      const name = request.FunctionName as string;
      functions.add(name);
      return lambdaJson(201, {
        FunctionName: name,
        FunctionArn: `arn:aws:lambda:us-east-1:${ACCOUNT_ID}:function:${name}`,
      });
    }
    const versions = pathname.match(/^\/2015-03-31\/functions\/([^/]+)\/versions$/);
    if (method === "POST" && versions) {
      return lambdaJson(201, { Version: "7" });
    }
    // Precreate prefers updating a function `observe` admitted; a missing
    // one falls back to create.
    const code = pathname.match(/^\/2015-03-31\/functions\/([^/]+)\/code$/);
    if (method === "PUT" && code && !functions.has(decodeURIComponent(code[1]!))) {
      return lambdaJson(404, { message: "Function not found" }, "ResourceNotFoundException");
    }
    const get = pathname.match(/^\/2015-03-31\/functions\/([^/]+)$/);
    if (method === "GET" && get) {
      return functions.has(decodeURIComponent(get[1]!))
        ? lambdaJson(200, { Configuration: {} })
        : lambdaJson(404, { message: "not found" }, "ResourceNotFoundException");
    }
    throw new Error(`unexpected Lambda request ${method} ${pathname}`);
  };

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.hostname}${url.pathname}${url.search}`);
      const raw = request.body as { body?: Uint8Array };
      const body = new TextDecoder().decode(raw.body ?? new Uint8Array());
      const handleLogs = () => {
        const target = request.headers["x-amz-target"];
        const input = JSON.parse(body) as {
          logGroupName?: string;
          tags?: Record<string, string>;
          resourceArn?: string;
        };
        if (target?.endsWith(".CreateLogGroup")) {
          logGroups.set(input.logGroupName!, options.omitLogGroupTags ? {} : (input.tags ?? {}));
          return lambdaJson(200, {});
        }
        if (target?.endsWith(".DeleteLogGroup")) {
          logGroups.delete(input.logGroupName!);
          return lambdaJson(200, {});
        }
        if (target?.endsWith(".ListTagsForResource")) {
          const name = input.resourceArn!.split(":log-group:")[1]!;
          const tags = logGroups.get(name);
          return tags === undefined
            ? lambdaJson(400, { message: "not found" }, "ResourceNotFoundException")
            : lambdaJson(200, { tags });
        }
        throw new Error(`unexpected Logs operation ${target}`);
      };
      const response = url.hostname.startsWith("logs.")
        ? handleLogs()
        : url.hostname.startsWith("iam.")
          ? handleIam(new URLSearchParams(body))
          : handleLambda(request.method, url.pathname, body);
      return HttpClientResponse.fromWeb(request, response);
    }),
  );

  const layer = Layer.mergeAll(
    mockCredentials,
    Region.of("us-east-1"),
    Layer.succeed(HttpClient.HttpClient, client),
    // Zip functions never build images; any Docker call is a test bug.
    Layer.succeed(Docker, {} as Docker["Service"]),
    Layer.succeed(
      AWSEnvironment,
      Effect.succeed({
        accountId: ACCOUNT_ID,
        region: "us-east-1",
        credentials: Effect.die("offline test must not resolve credentials"),
      }),
    ),
  );

  return {
    roles,
    roleTags,
    inlinePolicies,
    functions,
    logGroups,
    requests,
    createFunctionBodies,
    layer,
  };
};

const { test } = Test.make({
  providers: Lambda.FunctionProvider().pipe(Layer.provide(makeCloud().layer)),
});

const precreate = (
  id: string,
  cloud: ReturnType<typeof makeCloud>,
  props: Partial<Lambda.FunctionZipProps> = {},
) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Lambda.Function);
    return yield* provider.precreate!({
      id,
      fqn: id,
      instanceId: "0123456789abcdef0123456789abcdef",
      news: {
        main: "./handler.ts",
        ...props,
      },
      bindings: [],
      session: { ...noopSession, note: () => Effect.void },
    }).pipe(
      Effect.provideService(ResourceContext, {
        logicalId: id,
        fqn: id,
        instanceId: "0123456789abcdef0123456789abcdef",
        type: Lambda.Function.Type,
      }),
      // The engine provides the stack's cloud services at the call site.
      Effect.provide(cloud.layer),
    );
  });

test.provider(
  "a failed precreate releases the execution role and log group it created",
  () =>
    Effect.gen(function* () {
      const cloud = makeCloud({ failCreateFunction: true });
      const exit = yield* Effect.exit(precreate("FailedStub", cloud));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(cloud.createFunctionBodies).toHaveLength(1);
      // No function exists, so destroy's recovery `read` finds nothing and
      // drops the row — the role and log group must not outlive the failure.
      expect(cloud.functions.size).toBe(0);
      expect([...cloud.roles.keys()]).toEqual([]);
      expect(cloud.inlinePolicies.size).toBe(0);
      expect(cloud.logGroups.size).toBe(0);
    }),
  { tags: ["unit", "provider:aws", "provider:aws:lambda", "local"] },
);

test.provider(
  "a failed precreate keeps the role when the function exists",
  () =>
    Effect.gen(function* () {
      const cloud = makeCloud({ failCreateFunction: true, createFunctionBeforeFailure: true });
      const exit = yield* Effect.exit(precreate("ExistingStub", cloud));

      expect(Exit.isFailure(exit)).toBe(true);
      // A lost create response must not release resources a landed function uses.
      expect(cloud.functions.size).toBe(1);
      expect([...cloud.roles.keys()]).toHaveLength(1);
      expect(cloud.logGroups.size).toBe(1);
    }),
  { tags: ["unit", "provider:aws", "provider:aws:lambda", "local"] },
);

test.provider(
  "a failed precreate keeps a role it does not own",
  () =>
    Effect.gen(function* () {
      const cloud = makeCloud({ failCreateFunction: true, omitRoleTags: true });
      const exit = yield* Effect.exit(precreate("ForeignRoleStub", cloud));

      expect(Exit.isFailure(exit)).toBe(true);
      // The role carries no ownership tags, so it is not this instance's to
      // delete even though no function exists.
      expect([...cloud.roles.keys()]).toHaveLength(1);
      expect(cloud.logGroups.size).toBe(1);
    }),
  { tags: ["unit", "provider:aws", "provider:aws:lambda", "local"] },
);

test.provider(
  "a cleanup failure preserves the original precreate error",
  () =>
    Effect.gen(function* () {
      const cloud = makeCloud({ failCreateFunction: true, failDeleteRole: true });
      const exit = yield* Effect.exit(precreate("CleanupFailedStub", cloud));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const rendered = String(exit.cause);
        expect(rendered).toContain("stub rejected");
        expect(rendered).not.toContain("cleanup exploded");
      }
    }),
  { tags: ["unit", "provider:aws", "provider:aws:lambda", "local"] },
);

test.provider(
  "a failed precreate keeps a log group it does not own",
  () =>
    Effect.gen(function* () {
      const cloud = makeCloud({ failCreateFunction: true, omitLogGroupTags: true });
      const exit = yield* Effect.exit(precreate("ForeignLogsStub", cloud));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(cloud.roles.size).toBe(0);
      expect(cloud.logGroups.size).toBe(1);
    }),
  { tags: ["unit", "provider:aws", "provider:aws:lambda", "local"] },
);
