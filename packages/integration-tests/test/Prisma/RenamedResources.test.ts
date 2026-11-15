import {
  ComputeService as PrismaComputeService,
  ComputeServiceProvider,
} from "@alchemy.run/prisma/ComputeService";
import {
  ComputeVersion as PrismaComputeVersion,
  ComputeVersionProvider,
} from "@alchemy.run/prisma/ComputeVersion";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Provider from "alchemy/Provider";
import { isActionState, State } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type Captured,
  data,
  makeFakeManagementApi,
  noContent,
  notFound,
  page,
  routesOf,
  unhandled,
} from "./fixtures/FakeManagementApi.ts";

const createdAt = "2026-01-01T00:00:00.000Z";

interface WireService {
  id: string;
  type: string;
  url: string;
  name: string;
  region: { id: string; name: string };
  projectId: string;
  branchId: string | null;
  latestDeploymentId: string | null;
  appEndpointDomain: string;
  createdAt: string;
  logicalId: string | null;
}

interface WireDeployment {
  id: string;
  type: string;
  url: string;
  serviceId: string;
  foundryVersionId: string;
  status: string;
  previewDomain: string | null;
  createdAt: string;
}

/** An in-memory Management API holding the services and deployments the stack creates. */
const makeComputeCloud = () => {
  const services = new Map<string, WireService>();
  const deployments = new Map<string, WireDeployment>();

  const respond = (request: Captured) => {
    const [head, id, tail] = request.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .slice(1);
    const body = request.bodyJson as Record<string, unknown> | undefined;

    if (head === "services" && id === undefined && request.method === "GET") {
      const query = new URLSearchParams(request.search);
      return page(
        [...services.values()].filter(
          (service) =>
            (!query.has("projectId") || service.projectId === query.get("projectId")) &&
            (!query.has("logicalId") || service.logicalId === query.get("logicalId")) &&
            (!query.has("branchId") || service.branchId === query.get("branchId")),
        ),
      );
    }
    if (head === "services" && id === undefined && request.method === "POST") {
      const service: WireService = {
        id: `svc-${services.size + 1}`,
        type: "service",
        url: "",
        name: String(body?.displayName),
        region: { id: "us-east-1", name: "us-east-1" },
        projectId: String(body?.projectId),
        branchId: (body?.branchId as string | undefined) ?? null,
        latestDeploymentId: null,
        appEndpointDomain: `svc-${services.size + 1}.prisma.build`,
        createdAt,
        logicalId: (body?.logicalId as string | undefined) ?? null,
      };
      services.set(service.id, service);
      return data(service);
    }
    if (head === "services" && id !== undefined) {
      const service = services.get(id);
      if (!service) return notFound();
      if (tail === undefined && request.method === "GET") return data(service);
      if (tail === undefined && request.method === "DELETE") {
        services.delete(id);
        return noContent();
      }
      if (tail === "deployments" && request.method === "GET") {
        return page([...deployments.values()].filter((d) => d.serviceId === id));
      }
      if (tail === "deployments" && request.method === "POST") {
        const deployment: WireDeployment = {
          id: `dep-${deployments.size + 1}`,
          type: "deployment",
          url: "",
          serviceId: id,
          foundryVersionId: `foundry-${deployments.size + 1}`,
          status: "new",
          previewDomain: null,
          createdAt,
        };
        deployments.set(deployment.id, deployment);
        return data({ ...deployment, uploadUrl: null });
      }
    }
    if (head === "deployments" && id !== undefined) {
      const deployment = deployments.get(id);
      if (!deployment) return notFound();
      if (request.method === "GET") return data(deployment);
      if (request.method === "DELETE") {
        deployments.delete(id);
        return noContent();
      }
    }
    return unhandled(request);
  };

  return { fake: makeFakeManagementApi(respond), services, deployments };
};

class RenameTestProviders extends Provider.ProviderCollection<RenameTestProviders>()("Prisma") {}

const cloud = makeComputeCloud();

const providers = Layer.effect(
  RenameTestProviders,
  Provider.collection([PrismaComputeService, PrismaComputeVersion]),
).pipe(
  Layer.provideMerge(Layer.mergeAll(ComputeServiceProvider(), ComputeVersionProvider())),
  Layer.provide(
    Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy-test", dev: false, adopt: false }),
  ),
  Layer.provideMerge(cloud.fake.layer),
);

const { test } = Test.make({ providers });

const program = Effect.gen(function* () {
  const service = yield* PrismaComputeService("Service", {
    project: "project-1",
    branchId: "branch-1",
  });
  const version = yield* PrismaComputeVersion("Version", {
    service: service.serviceId,
    skipCodeUpload: true,
  });
  return { service, version };
});

/**
 * Rewrite a created row as an older Alchemy release wrote it: the old resource
 * type, and attribute and prop keys under their old names.
 */
const writeAsBeforeRename = (
  stack: Test.ScratchStack,
  fqn: string,
  resourceType: string,
  rename: { attr: Record<string, string>; props?: Record<string, string> },
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const address = { stack: stack.name, stage: stack.stage, fqn };
    const stored = yield* state.get(address);
    if (!stored || isActionState(stored) || stored.status !== "created") {
      return yield* Effect.die(new Error(`Expected a created state row for '${fqn}'`));
    }
    const renameKeys = (record: object, names: Record<string, string>) =>
      Object.fromEntries(Object.entries(record).map(([key, value]) => [names[key] ?? key, value]));
    yield* state.set({
      ...address,
      value: {
        ...stored,
        resourceType,
        attr: renameKeys(stored.attr as object, rename.attr),
        props: renameKeys(stored.props as object, rename.props ?? {}),
      },
    });
  }).pipe(Effect.provide(stack.state));

const readRow = (stack: Test.ScratchStack, fqn: string) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const stored = yield* state.get({ stack: stack.name, stage: stack.stage, fqn });
    if (!stored || isActionState(stored)) {
      return yield* Effect.die(new Error(`Expected a state row for '${fqn}'`));
    }
    return stored;
  }).pipe(Effect.provide(stack.state));

const writeRowsAsBeforeRename = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    yield* writeAsBeforeRename(stack, "Service", "Prisma.App", {
      attr: {
        serviceId: "appId",
        latestVersionId: "latestDeploymentId",
        serviceEndpointDomain: "appEndpointDomain",
      },
    });
    yield* writeAsBeforeRename(stack, "Version", "Prisma.Deployment", {
      attr: {
        versionId: "deploymentId",
        serviceId: "appId",
        serviceEndpointDomain: "appEndpointDomain",
      },
      props: { service: "app" },
    });
  });

test.provider(
  "reads Prisma.App and Prisma.Deployment rows under the new names without replacing them",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program);

      yield* writeRowsAsBeforeRename(stack);
      const legacyService = yield* readRow(stack, "Service");
      expect(legacyService.resourceType).toBe("Prisma.App");
      expect(legacyService.attr).toMatchObject({ appId: first.service.serviceId });

      cloud.fake.captured.length = 0;
      const second = yield* stack.deploy(program);

      const writes = routesOf(cloud.fake.captured).filter((route) => !route.startsWith("GET "));
      expect(writes).toEqual([]);
      expect(cloud.services.size).toBe(1);
      expect(cloud.deployments.size).toBe(1);
      expect(second.service.serviceId).toBe(first.service.serviceId);
      expect(second.service.serviceEndpointDomain).toBe(first.service.serviceEndpointDomain);
      expect(second.version.versionId).toBe(first.version.versionId);
      expect(second.version.serviceId).toBe(first.service.serviceId);

      const service = yield* readRow(stack, "Service");
      expect(service.resourceType).toBe("Prisma.ComputeService");
      expect(service.attr).toMatchObject({ serviceId: first.service.serviceId });
      expect(service.attr).not.toHaveProperty("appId");
      const version = yield* readRow(stack, "Version");
      expect(version.resourceType).toBe("Prisma.ComputeVersion");
      expect(version.attr).toMatchObject({
        versionId: first.version.versionId,
        serviceId: first.service.serviceId,
      });
      expect(version.attr).not.toHaveProperty("deploymentId");

      yield* stack.destroy();
      expect(cloud.services.size).toBe(0);
      expect(cloud.deployments.size).toBe(0);
    }),
  {
    tags: [
      "unit",
      "local",
      "provider:prisma",
      "provider:prisma:computeservice",
      "provider:prisma:computeversion",
    ],
  },
);

test.provider(
  "destroys Prisma.App and Prisma.Deployment rows through the renamed providers",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      yield* stack.deploy(program);
      yield* writeRowsAsBeforeRename(stack);

      yield* stack.destroy();
      expect(cloud.services.size).toBe(0);
      expect(cloud.deployments.size).toBe(0);
    }),
  {
    tags: [
      "unit",
      "local",
      "provider:prisma",
      "provider:prisma:computeservice",
      "provider:prisma:computeversion",
    ],
  },
);
