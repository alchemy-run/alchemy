import {
  PrismaApiError,
  PrismaClient,
  type PrismaManagementClient,
} from "@alchemy.run/prisma/Client";
import {
  ComputeService as PrismaComputeService,
  ComputeServiceProvider,
} from "@alchemy.run/prisma/ComputeService";
import {
  ComputeVersion as PrismaComputeVersion,
  ComputeVersionProvider,
} from "@alchemy.run/prisma/ComputeVersion";
import {
  CustomDomain as PrismaCustomDomain,
  CustomDomainProvider,
} from "@alchemy.run/prisma/CustomDomain";
import type { CustomDomain as ApiCustomDomain } from "@alchemy.run/prisma/Types";
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
  failure,
  makeFakeManagementApi,
  noContent,
  notFound,
  page,
  routesOf,
  unhandled,
} from "./fixtures/FakeManagementApi.ts";

const createdAt = "2026-01-01T00:00:00.000Z";

const tags = [
  "unit",
  "local",
  "provider:prisma",
  "provider:prisma:computeservice",
  "provider:prisma:computeversion",
  "provider:prisma:customdomain",
];

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

/**
 * An in-memory Management API holding the services, deployments and custom
 * domains a stack creates. Services and deployments are served over the wire;
 * custom domains through the client `Prisma.CustomDomain` resolves.
 */
const makeComputeCloud = () => {
  const services = new Map<string, WireService>();
  const deployments = new Map<string, WireDeployment>();
  const domains = new Map<string, ApiCustomDomain>();
  const domainWrites: string[] = [];
  let nextDeployment = 1;

  const respond = (request: Captured) => {
    const [head, id, tail] = request.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .slice(1);
    const body = request.bodyJson as Record<string, unknown> | undefined;

    if (head === "branches" && id !== undefined && request.method === "GET") {
      return data({
        id,
        type: "branch",
        url: "",
        gitName: id,
        isDefault: true,
        role: "production",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        project: { id: "project-1", url: "", name: "project-1" },
      });
    }
    // The platform's rule for a service's logical ID, in a query or a write.
    const logicalId =
      head === "services"
        ? request.method === "GET"
          ? new URLSearchParams(request.search).get("logicalId")
          : ((request.bodyJson as Record<string, unknown> | undefined)?.logicalId ?? null)
        : null;
    if (typeof logicalId === "string" && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(logicalId)) {
      return failure(
        422,
        "validation_error",
        "logicalId: logicalId must start with a letter or digit and contain only letters, digits, dots, dashes, and underscores",
      );
    }
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
        // Each version in these tests copies the promoted artifact.
        latestDeploymentId: "dep-promoted",
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
        // The platform deletes a service's versions with it.
        for (const deployment of [...deployments.values()]) {
          if (deployment.serviceId === id) deployments.delete(deployment.id);
        }
        return noContent();
      }
      if (tail === "deployments" && request.method === "GET") {
        return page([...deployments.values()].filter((d) => d.serviceId === id));
      }
      if (tail === "deployments" && request.method === "POST") {
        const number = nextDeployment++;
        const deployment: WireDeployment = {
          id: `dep-${number}`,
          type: "deployment",
          url: "",
          serviceId: id,
          foundryVersionId: `foundry-${number}`,
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

  const missingDomain = (id: string) =>
    new PrismaApiError({
      method: "GET",
      path: `/v1/domains/${id}`,
      status: 404,
      message: "not found",
    });

  const domainClient = {
    listAppDomains: (appId: string) =>
      Effect.sync(() => [...domains.values()].filter((domain) => domain.appId === appId)),
    getCustomDomain: (id: string) =>
      Effect.suspend(() => {
        const domain = domains.get(id);
        return domain ? Effect.succeed(domain) : Effect.fail(missingDomain(id));
      }),
    createAppDomain: (appId: string, input: { hostname: string }) =>
      Effect.sync(() => {
        domainWrites.push(`createAppDomain ${appId}`);
        const id = `domain-${domains.size + 1}`;
        const domain: ApiCustomDomain = {
          id,
          type: "custom-domain",
          url: "",
          hostname: input.hostname,
          appId,
          status: "active",
          foundryStatus: "active",
          failureReason: null,
          failureCategory: null,
          certExpiresAt: null,
          dnsRecords: [],
          createdAt,
          updatedAt: createdAt,
        };
        domains.set(id, domain);
        return { status: 201 as const, domain };
      }),
    retryCustomDomain: (id: string) =>
      Effect.sync(() => {
        domainWrites.push(`retryCustomDomain ${id}`);
        return domains.get(id)!;
      }),
    deleteCustomDomain: (id: string) =>
      Effect.sync(() => {
        domainWrites.push(`deleteCustomDomain ${id}`);
        domains.delete(id);
      }),
  } as unknown as PrismaManagementClient;

  return {
    fake: makeFakeManagementApi(respond),
    domainClient,
    services,
    deployments,
    domains,
    domainWrites,
  };
};

class RenameTestProviders extends Provider.ProviderCollection<RenameTestProviders>()("Prisma") {}

/** One fake cloud per test, so tests that run at the same time never share calls. */
const harness = (options: { dev: boolean }) => {
  const cloud = makeComputeCloud();
  const providers = Layer.effect(
    RenameTestProviders,
    Provider.collection([PrismaComputeService, PrismaComputeVersion, PrismaCustomDomain]),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(ComputeServiceProvider(), ComputeVersionProvider(), CustomDomainProvider()),
    ),
    Layer.provideMerge(Layer.succeed(PrismaClient, cloud.domainClient)),
    Layer.provide(
      Layer.succeed(AlchemyContext, {
        dotAlchemy: ".alchemy-test",
        dev: options.dev,
        adopt: false,
      }),
    ),
    Layer.provideMerge(cloud.fake.layer),
  );
  const { test } = Test.make({ providers, dev: options.dev, sidecar: false });
  return { cloud, test };
};

const program = (options: { revision: string }) =>
  Effect.gen(function* () {
    const service = yield* PrismaComputeService("Service", {
      project: "project-1",
      branchId: "branch-1",
    });
    const version = yield* PrismaComputeVersion("Version", {
      service: service.serviceId,
      skipCodeUpload: true,
      start: false,
      triggers: { REVISION: options.revision },
    });
    const domain = yield* PrismaCustomDomain("Domain", {
      service: service.serviceId,
      hostname: "api.renamed.invalid",
    });
    return { service, version, domain };
  });

/**
 * Rewrite a created row as an older Alchemy release wrote it: the old resource
 * type, and attribute and prop keys under their old names.
 */
const writeAsBeforeRename = (
  stack: Test.ScratchStack,
  fqn: string,
  rename: {
    type?: string;
    /** Old name for each attribute; `null` for one the old release did not write. */
    attr: Record<string, string | null>;
    props?: Record<string, string>;
  },
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const address = { stack: stack.name, stage: stack.stage, fqn };
    const stored = yield* state.get(address);
    if (!stored || isActionState(stored) || stored.status !== "created") {
      return yield* Effect.die(new Error(`Expected a created state row for '${fqn}'`));
    }
    const renameKeys = (record: object, names: Record<string, string | null>) =>
      Object.fromEntries(
        Object.entries(record).flatMap(([key, value]) => {
          const name = names[key];
          return name === null ? [] : [[name ?? key, value]];
        }),
      );
    yield* state.set({
      ...address,
      value: {
        ...stored,
        resourceType: rename.type ?? stored.resourceType,
        attr: renameKeys(stored.attr as object, rename.attr),
        props: renameKeys(stored.props as object, rename.props ?? {}),
      },
    });
  }).pipe(Effect.provide(stack.state));

const writeRowsAsBeforeRename = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    yield* writeAsBeforeRename(stack, "Service", {
      type: "Prisma.App",
      attr: {
        serviceId: "appId",
        activeVersionId: "latestDeploymentId",
        serviceEndpointDomain: "appEndpointDomain",
        url: null,
      },
    });
    yield* writeAsBeforeRename(stack, "Version", {
      type: "Prisma.Deployment",
      attr: {
        versionId: "deploymentId",
        serviceId: "appId",
        url: null,
      },
      props: { service: "app" },
    });
    yield* writeAsBeforeRename(stack, "Domain", {
      attr: { serviceId: "appId" },
      props: { service: "app" },
    });
  });

const readRow = (stack: Test.ScratchStack, fqn: string) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const stored = yield* state.get({ stack: stack.name, stage: stack.stage, fqn });
    if (!stored || isActionState(stored)) {
      return yield* Effect.die(new Error(`Expected a state row for '${fqn}'`));
    }
    return stored;
  }).pipe(Effect.provide(stack.state));

const expectRowsAfterRename = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    const service = yield* readRow(stack, "Service");
    expect(service.resourceType).toBe("Prisma.ComputeService");
    expect(Object.keys(service.attr as object)).toContain("serviceId");
    expect(service.attr).not.toHaveProperty("appId");
    expect(service.attr).not.toHaveProperty("latestDeploymentId");
    expect(service.attr).not.toHaveProperty("appEndpointDomain");
    const version = yield* readRow(stack, "Version");
    expect(version.resourceType).toBe("Prisma.ComputeVersion");
    expect(version.attr).not.toHaveProperty("deploymentId");
    expect(version.attr).not.toHaveProperty("appId");
    expect(version.attr).not.toHaveProperty("appEndpointDomain");
    const domain = yield* readRow(stack, "Domain");
    expect(domain.attr).not.toHaveProperty("appId");
    return { service, version, domain };
  });

const unchanged = harness({ dev: false });

unchanged.test.provider(
  "reads Prisma.App, Prisma.Deployment and Prisma.CustomDomain rows under the new names without replacing them",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = unchanged;
      yield* stack.destroy();

      const first = yield* stack.deploy(program({ revision: "1" }));
      yield* writeRowsAsBeforeRename(stack);
      expect((yield* readRow(stack, "Service")).resourceType).toBe("Prisma.App");

      cloud.fake.captured.length = 0;
      const second = yield* stack.deploy(program({ revision: "1" }));

      expect(routesOf(cloud.fake.captured).filter((route) => !route.startsWith("GET "))).toEqual(
        [],
      );
      expect(cloud.domainWrites).toEqual([`createAppDomain ${first.service.serviceId}`]);
      expect(cloud.services.size).toBe(1);
      expect(cloud.deployments.size).toBe(1);
      expect(cloud.domains.size).toBe(1);
      expect(second.service.serviceId).toBe(first.service.serviceId);
      expect(second.service.serviceEndpointDomain).toBe(first.service.serviceEndpointDomain);
      expect(second.version.versionId).toBe(first.version.versionId);
      expect(second.version.serviceId).toBe(first.service.serviceId);
      expect(second.domain.customDomainId).toBe(first.domain.customDomainId);
      expect(second.domain.serviceId).toBe(first.service.serviceId);

      const rows = yield* expectRowsAfterRename(stack);
      expect(rows.service.attr).toMatchObject({ serviceId: first.service.serviceId });
      expect(rows.version.attr).toMatchObject({
        versionId: first.version.versionId,
        serviceId: first.service.serviceId,
      });
      expect(rows.domain.attr).toMatchObject({ serviceId: first.service.serviceId });
      expect(rows.domain.props).toMatchObject({ service: first.service.serviceId });

      yield* stack.destroy();
      expect(cloud.services.size).toBe(0);
      expect(cloud.deployments.size).toBe(0);
      expect(cloud.domains.size).toBe(0);
    }),
  { tags },
);

const replaced = harness({ dev: false });

replaced.test.provider(
  "replaces a version saved as Prisma.Deployment when its triggers change on the first deploy after the rename",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = replaced;
      yield* stack.destroy();

      const first = yield* stack.deploy(program({ revision: "1" }));
      yield* writeRowsAsBeforeRename(stack);

      cloud.fake.captured.length = 0;
      const second = yield* stack.deploy(program({ revision: "2" }));

      // The old version is retained, not deleted: a version's default
      // removal policy keeps it on the platform for a rollback.
      expect(routesOf(cloud.fake.captured).filter((route) => !route.startsWith("GET "))).toEqual([
        `POST /v1/services/${first.service.serviceId}/deployments`,
      ]);
      expect(cloud.domainWrites).toEqual([`createAppDomain ${first.service.serviceId}`]);
      expect([...cloud.deployments.keys()].sort()).toEqual(
        [first.version.versionId, second.version.versionId].sort(),
      );
      expect(second.version.versionId).not.toBe(first.version.versionId);
      expect(second.version.serviceId).toBe(first.service.serviceId);
      expect(second.service.serviceId).toBe(first.service.serviceId);
      expect(second.domain.customDomainId).toBe(first.domain.customDomainId);

      const rows = yield* expectRowsAfterRename(stack);
      expect(rows.version.attr).toMatchObject({
        versionId: second.version.versionId,
        serviceId: first.service.serviceId,
      });

      yield* stack.destroy();
      expect(cloud.services.size).toBe(0);
      expect(cloud.deployments.size).toBe(0);
      expect(cloud.domains.size).toBe(0);
    }),
  { tags },
);

const destroyed = harness({ dev: false });

destroyed.test.provider(
  "destroys rows saved as Prisma.App and Prisma.Deployment through the renamed providers",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = destroyed;
      yield* stack.destroy();

      yield* stack.deploy(program({ revision: "1" }));
      yield* writeRowsAsBeforeRename(stack);

      yield* stack.destroy();
      expect(cloud.services.size).toBe(0);
      expect(cloud.deployments.size).toBe(0);
      expect(cloud.domains.size).toBe(0);
    }),
  { tags },
);

const dev = harness({ dev: true });

dev.test.provider(
  "reads local rows saved before the rename under the new names in alchemy dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program({ revision: "1" }));
      expect(first.service.serviceId).toBe("dev:app:Service");
      yield* writeRowsAsBeforeRename(stack);

      const second = yield* stack.deploy(program({ revision: "1" }));

      expect(second.service.serviceId).toBe(first.service.serviceId);
      expect(second.version.serviceId).toBe(first.service.serviceId);
      expect(second.domain.serviceId).toBe(first.service.serviceId);
      const rows = yield* expectRowsAfterRename(stack);
      expect(rows.version.attr).toMatchObject({ serviceId: first.service.serviceId });
      expect(rows.domain.attr).toMatchObject({ serviceId: first.service.serviceId });

      yield* stack.destroy();
    }),
  { tags },
);
