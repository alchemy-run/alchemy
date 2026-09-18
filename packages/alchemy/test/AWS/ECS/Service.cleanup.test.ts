import { Unowned } from "@/AdoptPolicy.ts";
import { AlchemyContext } from "@/AlchemyContext.ts";
import { Service, ServiceProvider } from "@/AWS/ECS/Service.ts";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { DockerLive } from "@/Docker/Docker.ts";
import { InstanceId } from "@/InstanceId.ts";
import { createPhysicalName } from "@/PhysicalName.ts";
import * as Provider from "@/Provider.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import * as Retry from "@distilled.cloud/aws/Retry";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const id = "Nodes";
const instanceId = "00112233445566778899aabbccddeeff";
const stackName = "Celld-EcsFleet-interrupted-service-cleanup";
const clusterArn = "arn:aws:ecs:us-west-2:123456789012:cluster/owned";
const tags = {
  "alchemy::stack": stackName,
  "alchemy::stage": "test",
  "alchemy::id": id,
};
const session = {
  emit: () => Effect.void,
  done: () => Effect.void,
  note: () => Effect.void,
};

type Options = {
  missingCluster?: boolean;
  noClusters?: boolean;
  missingService?: boolean;
  foreignService?: boolean;
  foreignRole?: boolean;
  rolesOnly?: boolean;
  empty?: boolean;
  referencedTask?: boolean;
  denied?: boolean;
};

const fixture = Effect.fn(function* (options: Options = {}) {
  const names = {
    service: yield* createPhysicalName({ id, maxLength: 255, lowercase: true }),
    family: yield* createPhysicalName({
      id: `${id}-task`,
      maxLength: 255,
      lowercase: true,
    }),
    taskRole: yield* createPhysicalName({
      id: `${id}-task-role`,
      maxLength: 64,
    }),
    executionRole: yield* createPhysicalName({
      id: `${id}-execution-role`,
      maxLength: 64,
    }),
    repository: yield* createPhysicalName({
      id: `${id}-repo`,
      maxLength: 256,
      lowercase: true,
    }),
    logs: yield* createPhysicalName({
      id: `${id}-logs`,
      maxLength: 512,
      lowercase: true,
    }),
  };
  const definitionArn = `arn:aws:ecs:us-west-2:123456789012:task-definition/${names.family}:1`;
  const serviceArn = `${clusterArn.replace(":cluster/", ":service/")}/${names.service}`;
  const calls: { action: string; body: Record<string, any> }[] = [];
  let serviceExists = !options.missingService;
  let roleExists = !options.empty;
  let infrastructureExists = !options.empty && !options.rolesOnly;
  const transport = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body._tag !== "Uint8Array")
        throw new Error("Expected AWS request body");
      const text = new TextDecoder().decode(request.body.body);
      const target = request.headers["x-amz-target"];
      const query = target ? undefined : new URLSearchParams(text);
      const action = target?.split(".").at(-1) ?? query!.get("Action")!;
      const body = target ? JSON.parse(text) : Object.fromEntries(query!);
      calls.push({ action, body });
      const json = (value: object, status = 200) =>
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(value), {
            status,
            headers: { "content-type": "application/x-amz-json-1.1" },
          }),
        );
      const error = (type: string, message = type) =>
        json({ __type: type, message }, 400);
      const xml = (value = "", status = 200) =>
        HttpClientResponse.fromWeb(
          request,
          new Response(value, {
            status,
            headers: { "content-type": "text/xml" },
          }),
        );
      const iamResponse = (value = "") =>
        xml(
          `<${action}Response><${action}Result>${value}</${action}Result><ResponseMetadata><RequestId>test</RequestId></ResponseMetadata></${action}Response>`,
        );
      const noRole = () =>
        xml(
          "<ErrorResponse><Error><Type>Sender</Type><Code>NoSuchEntity</Code><Message>Role does not exist</Message></Error><RequestId>test</RequestId></ErrorResponse>",
          404,
        );
      switch (action) {
        case "ListClusters":
          return json(
            options.noClusters
              ? { clusterArns: [] }
              : body.nextToken
                ? { clusterArns: [clusterArn] }
                : {
                    clusterArns: [
                      "arn:aws:ecs:us-west-2:123456789012:cluster/foreign",
                    ],
                    nextToken: "second",
                  },
          );
        case "DescribeServices": {
          if (options.denied) return error("AccessDeniedException");
          const foreign =
            body.cluster.endsWith("/foreign") || options.foreignService;
          return json({
            services: serviceExists
              ? [
                  {
                    serviceArn,
                    serviceName: names.service,
                    clusterArn: body.cluster,
                    taskDefinition: definitionArn,
                    status: "ACTIVE",
                    desiredCount: 0,
                    runningCount: 0,
                    pendingCount: 0,
                    tags: Object.entries(
                      foreign ? { ...tags, "alchemy::stack": "foreign" } : tags,
                    ).map(([key, value]) => ({ key, value })),
                  },
                ]
              : [],
            failures: [],
          });
        }
        case "GetRole": {
          if (!roleExists) return noRole();
          expect([names.taskRole, names.executionRole]).toContain(
            body.RoleName,
          );
          const roleTags = options.foreignRole
            ? { ...tags, "alchemy::stack": "foreign" }
            : tags;
          return iamResponse(
            `<Role><Path>/</Path><RoleName>${body.RoleName}</RoleName><RoleId>test</RoleId><Arn>arn:aws:iam::123456789012:role/${body.RoleName}</Arn><CreateDate>2026-09-18T00:00:00Z</CreateDate><Tags>${Object.entries(
              roleTags,
            )
              .map(
                ([Key, Value]) =>
                  `<member><Key>${Key}</Key><Value>${Value}</Value></member>`,
              )
              .join("")}</Tags></Role>`,
          );
        }
        case "ListTagsLogGroup":
          expect(body.logGroupName).toBe(names.logs);
          return infrastructureExists
            ? json({ tags })
            : error("ResourceNotFoundException");
        case "DescribeRepositories":
          expect(body.repositoryNames).toEqual([names.repository]);
          return infrastructureExists
            ? json({
                repositories: [
                  {
                    repositoryArn: `arn:aws:ecr:us-west-2:123456789012:repository/${names.repository}`,
                    repositoryName: names.repository,
                  },
                ],
              })
            : error("RepositoryNotFoundException");
        case "ListTagsForResource":
          return json({
            tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
          });
        case "DescribeTaskDefinition":
          expect([names.family, definitionArn]).toContain(body.taskDefinition);
          return infrastructureExists
            ? json({
                taskDefinition: {
                  taskDefinitionArn: definitionArn,
                  family: names.family,
                },
                tags: Object.entries(tags).map(([key, value]) => ({
                  key,
                  value,
                })),
              })
            : error("ClientException", "Unable to describe task definition.");
        case "UpdateService":
          expect(body.cluster).toBe(clusterArn);
          expect(body.service).toBe(names.service);
          expect(body.desiredCount).toBe(0);
          return serviceExists ? json({}) : error("ServiceNotFoundException");
        case "DeleteService":
          serviceExists = false;
          return json({});
        case "ListTasks":
          return json({ taskArns: [] });
        case "ListTaskDefinitions":
          expect(body.familyPrefix).toBe(names.family);
          return json({
            taskDefinitionArns: infrastructureExists
              ? [definitionArn, `${definitionArn.replace(/:1$/, "-foreign:1")}`]
              : [],
          });
        case "DeregisterTaskDefinition":
          expect([definitionArn, names.family]).toContain(body.taskDefinition);
          return json({});
        case "DeleteTaskDefinitions":
          expect(body.taskDefinitions).toHaveLength(1);
          expect([definitionArn, names.family]).toContain(
            body.taskDefinitions[0],
          );
          return json({});
        case "DeleteRepository":
          expect(body.repositoryName).toBe(names.repository);
          return infrastructureExists
            ? json({})
            : error("RepositoryNotFoundException");
        case "DeleteLogGroup":
          expect(body.logGroupName).toBe(names.logs);
          infrastructureExists = false;
          return json({});
        case "ListRolePolicies":
          return roleExists
            ? iamResponse(
                "<PolicyNames><member>bindings</member></PolicyNames><IsTruncated>false</IsTruncated>",
              )
            : noRole();
        case "ListAttachedRolePolicies":
          return roleExists
            ? iamResponse(
                "<AttachedPolicies><member><PolicyName>BucketAccess</PolicyName><PolicyArn>arn:aws:iam::123456789012:policy/BucketAccess</PolicyArn></member></AttachedPolicies><IsTruncated>false</IsTruncated>",
              )
            : noRole();
        case "DeleteRolePolicy":
        case "DetachRolePolicy":
        case "DeleteRole":
          expect([names.taskRole, names.executionRole]).toContain(
            body.RoleName,
          );
          if (action === "DeleteRole" && body.RoleName === names.executionRole)
            roleExists = false;
          return iamResponse();
        default:
          throw new Error(`Unexpected AWS request: ${action}`);
      }
    }),
  );
  const credentials = Effect.succeed({
    accessKeyId: Redacted.make("AKIATEST"),
    secretAccessKey: Redacted.make("test"),
    sessionToken: undefined,
    region: "us-west-2" as const,
  });
  const layer = ServiceProvider().pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, transport),
        Layer.succeed(Credentials, credentials),
        Layer.succeed(
          AWSEnvironment,
          Effect.succeed({
            accountId: "123456789012",
            region: "us-west-2",
            credentials,
          }),
        ),
        Layer.succeed(Region, Effect.succeed("us-west-2")),
        Layer.succeed(AlchemyContext, {
          dev: false,
          adopt: false,
          dotAlchemy: ".alchemy",
        }),
        DockerLive.pipe(Layer.provideMerge(BunServices.layer)),
      ),
    ),
  );
  const input = {
    id,
    fqn: "Cells/Nodes",
    instanceId,
    olds: {
      cluster: options.missingCluster ? {} : clusterArn,
      ...(options.referencedTask
        ? {
            task: {
              taskDefinitionArn: definitionArn,
              containerName: "main",
              port: 8080,
            },
          }
        : { image: "busybox:stable" }),
    } as Service["Props"],
    output: undefined,
  };
  const provider = Provider.Provider<Service>(Service.Type);
  const read = Effect.flatMap(provider, (provider) =>
    provider.read!(input),
  ).pipe(Retry.none, Effect.provide(layer));
  const remove = (output: Service["Attributes"]) =>
    Effect.flatMap(provider, (provider) =>
      provider.delete({ ...input, output, bindings: [], session }),
    ).pipe(Retry.none, Effect.provide(layer));
  return { read, remove, calls, names, definitionArn, serviceArn };
});

const testLayer = Layer.mergeAll(
  Layer.succeed(Stack, {
    name: stackName,
    stage: "test",
    resources: {},
    bindings: {},
    actions: {},
  }),
  Layer.succeed(Stage, "test"),
  Layer.succeed(InstanceId, instanceId),
);

const recovered = (value: Service["Attributes"] | undefined) => {
  expect(value).toBeDefined();
  expect(Unowned.is(value)).toBe(false);
  if (!value) throw new Error("Expected recovered service");
  return value;
};

const mutationActions = new Set([
  "UpdateService",
  "DeleteService",
  "DeregisterTaskDefinition",
  "DeleteTaskDefinitions",
  "DeleteRepository",
  "DeleteLogGroup",
  "DeleteRole",
  "DetachRolePolicy",
  "DeleteRolePolicy",
]);

describe("ECS Service interrupted-create cleanup", () => {
  for (const missingCluster of [false, true]) {
    it.effect(
      `recovers owned infrastructure with ${missingCluster ? "stripped" : "persisted"} cluster props and deletes it idempotently`,
      () =>
        Effect.gen(function* () {
          const test = yield* fixture({ missingCluster });
          const output = recovered(yield* test.read);
          expect(output.clusterArn).toBe(clusterArn);
          expect(output.taskFamily).toBe(test.names.family);
          expect(output.taskRoleName).toBe(test.names.taskRole);
          expect(output.executionRoleName).toBe(test.names.executionRole);
          expect(output.taskRoleName).not.toBe(output.executionRoleName);
          expect(output.repositoryName).toBe(test.names.repository);
          expect(output.logGroupName).toBe(test.names.logs);
          if (missingCluster)
            expect(
              test.calls.filter((call) => call.action === "ListClusters"),
            ).toHaveLength(2);
          yield* test.remove(output);
          expect(
            test.calls
              .filter((call) => call.action === "DetachRolePolicy")
              .map((call) => call.body.RoleName),
          ).toEqual([test.names.taskRole, test.names.executionRole]);
          expect(
            test.calls
              .filter((call) => call.action === "DeleteRole")
              .map((call) => call.body.RoleName),
          ).toEqual([test.names.taskRole, test.names.executionRole]);
          yield* test.remove(output);
        }).pipe(Effect.provide(testLayer)),
    );
  }

  it.effect("hydrates legacy read attributes again on delete", () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      yield* test.remove({
        serviceArn: test.serviceArn as Service["Attributes"]["serviceArn"],
        serviceName: test.names.service,
        clusterArn,
        taskDefinitionArn: test.definitionArn,
        status: "ACTIVE",
      });
      expect(
        test.calls.some((call) => call.action === "DetachRolePolicy"),
      ).toBe(true);
      expect(
        test.calls.filter((call) => call.action === "DeleteRole"),
      ).toHaveLength(2);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("recovers roles created before service/task registration", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ rolesOnly: true, missingService: true });
      const output = recovered(yield* test.read);
      expect(output.status).toBe("INACTIVE");
      yield* test.remove(output);
      expect(
        test.calls.filter((call) => call.action === "DeleteRole"),
      ).toHaveLength(2);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "never infers ownership of a referenced task's infrastructure",
    () =>
      Effect.gen(function* () {
        const test = yield* fixture({ referencedTask: true });
        const output = recovered(yield* test.read);
        expect(output.taskFamily).toBeUndefined();
        yield* test.remove(output);
        expect(
          test.calls.some(
            (call) =>
              call.action === "GetRole" ||
              call.action === "DeleteRole" ||
              call.action === "DeregisterTaskDefinition",
          ),
        ).toBe(false);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("brands foreign services without recovering their children", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ foreignService: true });
      expect(Unowned.is(yield* test.read)).toBe(true);
      expect(test.calls.map((call) => call.action)).toEqual([
        "DescribeServices",
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "refuses a deterministic role whose ownership tags do not match",
    () =>
      Effect.gen(function* () {
        const test = yield* fixture({ foreignRole: true });
        const result = yield* test.read.pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure._tag).toBe("ServiceRecoveryIncomplete");
        expect(
          test.calls.some((call) => mutationActions.has(call.action)),
        ).toBe(false);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "does not forget surviving children when the cluster is unrecoverable",
    () =>
      Effect.gen(function* () {
        const test = yield* fixture({
          missingCluster: true,
          noClusters: true,
          missingService: true,
        });
        const result = yield* test.read.pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure._tag).toBe("ServiceRecoveryIncomplete");
        expect(
          test.calls.some((call) => mutationActions.has(call.action)),
        ).toBe(false);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "returns absent only when neither service nor owned children remain",
    () =>
      Effect.gen(function* () {
        const test = yield* fixture({
          missingCluster: true,
          noClusters: true,
          missingService: true,
          empty: true,
        });
        expect(yield* test.read).toBeUndefined();
      }).pipe(Effect.provide(testLayer)),
  );
});
