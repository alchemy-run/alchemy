/**
 * Offline coverage for `AWS.Lambda.Function` precreate's layer handling.
 *
 * Precreate runs against UNRESOLVED props: a layer created in the same deploy
 * (e.g. `layers: [managedArn, sameDeployLayer]`) is still an Output when the
 * stub is created. The stub must omit `Layers` instead of serializing a
 * pending ARN, and reconcile attaches the resolved list (including `[]`, so
 * removing a layer detaches it). These tests drive the provider against an
 * in-memory IAM + Lambda + Logs account over a fake HTTP client, pinning the
 * exact requests without a cloud account.
 */
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Region from "@alchemy.run/aws/Region";
import { Docker } from "@alchemy.run/docker/Docker";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { noopSession } from "alchemy/Report";
import { ResourceContext } from "alchemy/ResourceContext";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const ACCOUNT_ID = "123456789012";
const MANAGED_LAYER =
  "arn:aws:lambda:us-east-1:901920570463:layer:aws-otel-collector-amd64-ver-0-102-1:1";

/** In-memory IAM + Lambda + Logs account served over a fake HTTP client. */
const makeCloud = () => {
  const roles = new Map<string, Set<string>>();
  const functions = new Set<string>();
  const inlinePolicies = new Map<string, Map<string, string>>();
  const logGroups = new Set<string>();
  const requests: string[] = [];
  const createFunctionBodies: Array<Record<string, unknown>> = [];
  const configurationBodies: Array<Record<string, unknown>> = [];

  const xml = (body: string, status = 200) =>
    new Response(body, { status, headers: { "content-type": "text/xml" } });
  const iamXml = (action: string, result = "") =>
    xml(
      `<${action}Response xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><${action}Result>${result}</${action}Result><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></${action}Response>`,
    );
  const noSuchEntity = () =>
    xml(
      `<ErrorResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><Error><Type>Sender</Type><Code>NoSuchEntity</Code><Message>not found</Message></Error><RequestId>r</RequestId></ErrorResponse>`,
      404,
    );
  const roleXml = (roleName: string) =>
    `<Role><Path>/</Path><RoleName>${roleName}</RoleName><RoleId>AROATEST</RoleId><Arn>arn:aws:iam::${ACCOUNT_ID}:role/${roleName}</Arn><CreateDate>2026-01-01T00:00:00Z</CreateDate></Role>`;

  const handleIam = (params: URLSearchParams) => {
    const action = params.get("Action")!;
    const roleName = params.get("RoleName") ?? "";
    const policies = roles.get(roleName);
    if (action !== "CreateRole" && policies === undefined) {
      return noSuchEntity();
    }
    switch (action) {
      case "GetRole":
        return iamXml(action, roleXml(roleName));
      case "CreateRole":
        roles.set(roleName, new Set());
        inlinePolicies.set(roleName, new Map());
        return iamXml(action, roleXml(roleName));
      case "GetRolePolicy": {
        const policy = inlinePolicies.get(roleName)?.get(params.get("PolicyName")!);
        return policy === undefined
          ? noSuchEntity()
          : iamXml(action, `<PolicyDocument>${encodeURIComponent(policy)}</PolicyDocument>`);
      }
      case "PutRolePolicy":
        inlinePolicies.get(roleName)!.set(params.get("PolicyName")!, params.get("PolicyDocument")!);
        return iamXml(action);
      case "DeleteRolePolicy":
        inlinePolicies.get(roleName)!.delete(params.get("PolicyName")!);
        return iamXml(action);
      case "AttachRolePolicy":
        policies!.add(params.get("PolicyArn")!);
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
      const name = request.FunctionName as string;
      functions.add(name);
      return lambdaJson(201, {
        FunctionName: name,
        FunctionArn: `arn:aws:lambda:us-east-1:${ACCOUNT_ID}:function:${name}`,
      });
    }
    // Precreate prefers updating a function `observe` admitted; a missing one
    // falls back to create.
    const code = pathname.match(/^\/2015-03-31\/functions\/([^/]+)\/code$/);
    if (method === "PUT" && code) {
      return functions.has(decodeURIComponent(code[1]!))
        ? lambdaJson(200, {})
        : lambdaJson(404, { message: "Function not found" }, "ResourceNotFoundException");
    }
    if (method === "PUT" && pathname.endsWith("/configuration")) {
      configurationBodies.push(JSON.parse(body) as Record<string, unknown>);
      // Stop after the wire boundary under test, before polling Lambda state.
      return lambdaJson(
        400,
        { message: "configuration captured" },
        "InvalidParameterValueException",
      );
    }
    throw new Error(`unexpected Lambda request ${method} ${pathname}`);
  };

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.hostname}${url.pathname}${url.search}`);
      const raw = request.body;
      const body = raw._tag === "Uint8Array" ? new TextDecoder().decode(raw.body) : "";
      const logs = () => {
        const target = request.headers["x-amz-target"];
        const input = JSON.parse(body) as { logGroupName: string };
        if (target?.endsWith(".CreateLogGroup")) logGroups.add(input.logGroupName);
        else throw new Error(`unexpected Logs operation ${target}`);
        return lambdaJson(200, {});
      };
      const response = url.hostname.startsWith("logs.")
        ? logs()
        : url.hostname.startsWith("iam.")
          ? handleIam(new URLSearchParams(body))
          : handleLambda(request.method, url.pathname, body);
      return HttpClientResponse.fromWeb(request, response);
    }),
  );

  const layer = Layer.mergeAll(
    Layer.succeed(
      Credentials,
      Effect.succeed({
        accessKeyId: Redacted.make("test"),
        secretAccessKey: Redacted.make("test"),
        sessionToken: undefined,
        region: "us-east-1" as RegionName,
      }),
    ),
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
    functions,
    inlinePolicies,
    logGroups,
    requests,
    createFunctionBodies,
    configurationBodies,
    layer,
  };
};

const { test } = Test.make({
  providers: Lambda.FunctionProvider().pipe(Layer.provide(makeCloud().layer)),
});

/** A layer created in the same deploy: unresolved while precreate runs. */
const sameDeployLayer = Output.of({
  Type: "AWS.Lambda.LayerVersion",
  LogicalId: "Config",
  FQN: "Config",
  Namespace: undefined,
} as any) as unknown as Lambda.LayerRef;

const precreate = (
  id: string,
  cloud: ReturnType<typeof makeCloud>,
  layers: Lambda.LayerRef[] = [],
) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Lambda.Function);
    return yield* provider.precreate!({
      id,
      fqn: id,
      instanceId: "0123456789abcdef0123456789abcdef",
      news: { main: "./handler.ts", layers },
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
  "precreate omits Layers while a layer is still an unresolved Output",
  () =>
    Effect.gen(function* () {
      const cloud = makeCloud();
      const output = yield* precreate("LayeredStub", cloud, [MANAGED_LAYER, sameDeployLayer]);

      expect(cloud.createFunctionBodies).toHaveLength(1);
      // Reconcile attaches the resolved layer set; the stub sends no key.
      expect(cloud.createFunctionBodies[0]).not.toHaveProperty("Layers");
      expect(cloud.functions.has(output.functionName)).toBe(true);
      expect(cloud.roles.has(output.roleName)).toBe(true);
    }),
  { tags: ["unit", "provider:aws", "provider:aws:lambda", "local"] },
);

test.provider(
  "precreate keeps Layers off the stub even when every layer is resolved",
  () =>
    Effect.gen(function* () {
      const cloud = makeCloud();
      yield* precreate("ManagedLayerStub", cloud, [MANAGED_LAYER]);

      expect(cloud.createFunctionBodies).toHaveLength(1);
      expect(cloud.createFunctionBodies[0]).not.toHaveProperty("Layers");
      // The managed ARN reaches Lambda only from reconcile.
      expect(JSON.stringify(cloud.createFunctionBodies[0])).not.toContain(MANAGED_LAYER);
    }),
  { tags: ["unit", "provider:aws", "provider:aws:lambda", "local"] },
);

for (const layers of [[MANAGED_LAYER], [], undefined]) {
  test.provider(
    `reconcile sends explicit Layers for ${JSON.stringify(layers) ?? "an omitted prop"}`,
    () =>
      Effect.gen(function* () {
        const id = "LayerConfiguration";
        const cloud = makeCloud();
        const output = yield* precreate(id, cloud);
        const provider = yield* Provider.findProvider(Lambda.Function);
        const props = {
          main: new URL("./fixtures/layers-prebuilt/index.mjs", import.meta.url).pathname,
          bundle: false as const,
          layers,
        };
        yield* Effect.exit(
          provider
            .reconcile({
              id,
              fqn: id,
              instanceId: "0123456789abcdef0123456789abcdef",
              news: props,
              olds: { ...props, layers: [MANAGED_LAYER] },
              output,
              bindings: [],
              session: { ...noopSession, note: () => Effect.void },
            })
            .pipe(
              Effect.provideService(ResourceContext, {
                logicalId: id,
                fqn: id,
                instanceId: "0123456789abcdef0123456789abcdef",
                type: Lambda.Function.Type,
              }),
              Effect.provide(cloud.layer),
            ),
        );
        expect(cloud.configurationBodies).toHaveLength(1);
        expect(cloud.configurationBodies[0]?.Layers).toEqual(layers ?? []);
      }),
    { tags: ["unit", "provider:aws", "provider:aws:lambda", "local"] },
  );
}
