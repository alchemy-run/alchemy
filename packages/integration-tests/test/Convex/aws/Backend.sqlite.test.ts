import * as Convex from "@alchemy.run/convex/aws";
import { InstanceNameChanged } from "@alchemy.run/convex/internal/selfhosted";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Result from "effect/Result";
import { assertDevAccount } from "./guard.ts";
import {
  assertRuntime,
  BACKEND_IMAGE,
  listMessages,
  selfHostedApp,
  skipPaid,
  TEST_DOMAIN,
} from "./support.ts";

const { test } = Test.make({ providers: Convex.providers() });

const domain = {
  cloud: `convex-sqlite-cloud.${TEST_DOMAIN}`,
  site: `convex-sqlite-site.${TEST_DOMAIN}`,
};

const app = (
  rootDir: string | undefined,
  env: NonNullable<Convex.BackendProps["env"]>,
  instanceName?: string,
) =>
  Effect.gen(function* () {
    const backend = yield* Convex.Backend("Backend", {
      image: BACKEND_IMAGE,
      domain,
      db: { engine: "sqlite" },
      deletionProtection: false,
      cpu: 512,
      memory: 1024,
      env,
      instanceName,
    });
    if (rootDir !== undefined) yield* Convex.Functions("Functions", { backend, rootDir });
    return backend;
  });

// One long test, because each deploy costs minutes.
test.provider.skipIf(skipPaid)(
  "sqlite backend end to end on AWS",
  (stack) =>
    Effect.gen(function* () {
      yield* assertDevAccount;
      yield* stack.destroy();
      const rootDir = yield* selfHostedApp("backend-sqlite");

      // Site port is healthy with no HTTP routes, before any push.
      const backend = yield* stack.deploy(app(undefined, { RUST_LOG: "info" }));
      const cluster = backend.service.clusterArn;
      const { services } = yield* ecs.describeServices({
        cluster,
        services: [backend.service.serviceArn],
      });
      const service = services![0]!;
      const groups = (service.loadBalancers ?? []).map((group) => group.targetGroupArn!);
      expect(groups.length).toBe(2);
      for (const group of groups) {
        const health = yield* elbv2.describeTargetHealth({ TargetGroupArn: group });
        expect(health.TargetHealthDescriptions?.[0]?.TargetHealth?.State).toBe("healthy");
      }

      // A query, a subscription and an HTTP action, through the public hosts,
      // with a socket held past the default 60 second load balancer timeout.
      const pushed = yield* stack.deploy(app(rootDir, { RUST_LOG: "info" }));
      yield* assertRuntime({
        url: pushed.url,
        siteUrl: pushed.siteUrl,
        text: "written through the load balancer",
        holdSocketSeconds: 70,
      });

      // Rollout is stop-first, with one task.
      expect(service.desiredCount).toBe(1);
      expect(service.deploymentConfiguration?.minimumHealthyPercent).toBe(0);
      expect(service.deploymentConfiguration?.maximumPercent).toBe(100);
      expect(service.healthCheckGracePeriodSeconds).toBe(120);

      // Task definition holds no secret.
      const { taskDefinition } = yield* ecs.describeTaskDefinition({
        taskDefinition: service.taskDefinition!,
      });
      const container = taskDefinition!.containerDefinitions![0]!;
      const environment = (container.environment ?? []).map((entry) => entry.name);
      expect(environment).not.toContain("INSTANCE_SECRET");
      expect(JSON.stringify(container)).not.toContain(`${backend.instanceName}|`);
      const secret = container.secrets?.find((entry) => entry.name === "INSTANCE_SECRET");
      expect(secret?.valueFrom).toContain(":ssm:");

      // Execution role reads only its parameters.
      const roleName = taskDefinition!.executionRoleArn!.split("/").at(-1)!;
      const policy = yield* iam.getRolePolicy({
        RoleName: roleName,
        PolicyName: "alchemy-secrets",
      });
      const document = JSON.parse(decodeURIComponent(policy.PolicyDocument!));
      expect(JSON.stringify(document)).toContain(secret!.valueFrom);
      expect(JSON.stringify(document)).not.toContain('"*"');

      // Port 80 redirects.
      const http = yield* HttpClient.HttpClient;
      const redirect = yield* http
        .get(`http://${domain.cloud}/version`)
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
      expect(redirect.status).toBe(301);
      expect(redirect.headers.location).toMatch(/^https:\/\//);

      // Data survives a redeploy that restarts the task, because SQLite is on EFS.
      const before = yield* ecs.listTasks({ cluster, serviceName: service.serviceName });
      const redeployed = yield* stack.deploy(app(rootDir, { RUST_LOG: "warn" }));
      const after = yield* ecs.listTasks({ cluster, serviceName: service.serviceName });
      expect(after.taskArns).not.toEqual(before.taskArns);
      expect(yield* listMessages(redeployed.url)).toContain("written through the load balancer");

      // An instance name change fails before touching the service.
      const current = yield* ecs.describeServices({
        cluster,
        services: [backend.service.serviceArn],
      });
      const currentTask = current.services![0]!.taskDefinition;
      const renamed = yield* stack
        .deploy(app(rootDir, { RUST_LOG: "warn" }, "other"))
        .pipe(Effect.result);
      expect(Result.isFailure(renamed)).toBe(true);
      if (Result.isFailure(renamed)) expect(renamed.failure).toBeInstanceOf(InstanceNameChanged);
      const unchanged = yield* ecs.describeServices({
        cluster,
        services: [backend.service.serviceArn],
      });
      expect(unchanged.services![0]!.taskDefinition).toBe(currentTask);
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:convex", "provider:convex:backend", "provider:aws", "live"],
    timeout: 2_400_000,
  },
);
