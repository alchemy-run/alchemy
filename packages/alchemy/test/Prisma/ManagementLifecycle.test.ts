import {
  createEnvironmentVariable,
  createProjectDatabase,
  getBranch,
  getDatabase,
  getEnvironmentVariable,
  getProject,
  getProjectDatabases,
  updateBranch,
  updateEnvironmentVariable,
} from "@distilled.cloud/prisma/management";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import { AlchemyContext } from "@/AlchemyContext";
import * as Prisma from "@/Prisma";
import { Branch as PrismaBranch, BranchProvider } from "@/Prisma/Branch";
import { PrismaApiError, PrismaClient } from "@/Prisma/Client";
import type { PrismaManagementClient } from "@/Prisma/Client";
import { CustomDomain as PrismaCustomDomain, CustomDomainProvider } from "@/Prisma/CustomDomain";
import { Database as PrismaDatabase, DatabaseProvider } from "@/Prisma/Database";
import {
  EnvironmentVariable as PrismaEnvironmentVariable,
  EnvironmentVariableProvider,
} from "@/Prisma/EnvironmentVariable";
import { recoverDatabaseConnectionSecrets } from "@/Prisma/Internal/DatabaseSecrets";
import { Project as PrismaProject, ProjectProvider } from "@/Prisma/Project";
import {
  SourceRepository as PrismaSourceRepository,
  SourceRepositoryProvider,
} from "@/Prisma/SourceRepository";
import type {
  Branch as ApiBranch,
  CustomDomain as ApiCustomDomain,
  Database as ApiDatabase,
  DatabaseConnectionWithSecrets,
  Project as ApiProject,
  SourceRepository as ApiSourceRepository,
} from "@/Prisma/Types";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import {
  conflict,
  data,
  dispatchTo,
  type FakeManagementApi,
  json,
  makeFakeManagementApi,
  notFound,
  page,
  unhandled,
} from "./fixtures/FakeManagementApi.ts";
import { patchSettledAttr } from "./fixtures/LifecycleState.ts";
import {
  expectGone,
  expectProjectGone,
  failureOf,
  forgetState,
  markCreating,
  patchStateAttr,
} from "./fixtures/Live.ts";

const createdAt = "2026-01-01T00:00:00.000Z";

const liveProviderContext = Layer.succeed(AlchemyContext, {
  dotAlchemy: ".alchemy-test",
  dev: false,
  adopt: false,
});

class TestPrismaProviders extends Provider.ProviderCollection<TestPrismaProviders>()("Prisma") {}

const projectLayer = (fake: FakeManagementApi) =>
  Layer.effect(TestPrismaProviders, Provider.collection([PrismaProject])).pipe(
    Layer.provideMerge(ProjectProvider()),
    Layer.provide(liveProviderContext),
    Layer.provideMerge(fake.layer),
  );

/** Wire serializers for the in-memory cloud's Types.ts-shaped records. */
const toWireProject = (project: ApiProject) => ({ ...project, logicalId: null });

const toWireDatabase = (database: ApiDatabase) => database;

const toWireCreatedDatabase = (database: ApiDatabase) => ({
  ...database,
  apiKeys: [],
  connectionString: "postgres://direct",
  directConnection: { host: "db.prisma.test", user: "prisma", pass: "secret" },
});

const branchLayer = (fake: FakeManagementApi) =>
  Layer.effect(TestPrismaProviders, Provider.collection([PrismaBranch])).pipe(
    Layer.provideMerge(BranchProvider()),
    Layer.provide(liveProviderContext),
    Layer.provideMerge(fake.layer),
  );

const databaseLayer = (fake: FakeManagementApi) =>
  Layer.effect(TestPrismaProviders, Provider.collection([PrismaDatabase])).pipe(
    Layer.provideMerge(DatabaseProvider()),
    Layer.provide(liveProviderContext),
    Layer.provideMerge(fake.layer),
  );

/**
 * Serve the Management API from the same hermetic client-shaped handlers this
 * suite declares, for the resources that now call distilled operations.
 * `dispatchTo` maps each handler's result onto the wire (see the fixture).
 */
const clientBackedApi = (client: any) =>
  makeFakeManagementApi((request) => {
    // segments[0] is the "v1" prefix.
    const [head, id, tail] = request.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .slice(1);
    const body = request.bodyJson as any;
    const query = Object.fromEntries(new URLSearchParams(request.search));
    const { call, callVoid, list } = dispatchTo(request);

    if (head === "projects") {
      if (id === undefined && request.method === "GET") {
        return call(client.listProjects, [], list);
      }
      if (tail === "branches" && request.method === "GET") {
        return call(client.listBranches, [id, query], list);
      }
      if (tail === "databases" && request.method === "GET") {
        return call(client.listProjectDatabases, [id, query], list);
      }
    }
    if (head === "services" && id === undefined && request.method === "GET") {
      return call(client.listApps, [query], list);
    }
    if (head === "environment-variables") {
      if (id === undefined) {
        return request.method === "GET"
          ? call(client.listEnvironmentVariables, [query], list)
          : call(client.createEnvironmentVariable, [body]);
      }
      if (request.method === "GET") {
        return call(client.getEnvironmentVariable, [id]);
      }
      if (request.method === "PATCH") {
        return call(client.updateEnvironmentVariable, [id, body]);
      }
      if (request.method === "DELETE") {
        return callVoid(client.deleteEnvironmentVariable, [id]);
      }
    }
    if (head === "source-repositories") {
      if (id === undefined) {
        return request.method === "GET"
          ? call(client.listSourceRepositories, [query], list)
          : call(client.createSourceRepository, [body]);
      }
      if (request.method === "GET") {
        return call(client.getSourceRepository, [id]);
      }
      if (request.method === "DELETE") {
        return callVoid(client.deleteSourceRepository, [id]);
      }
    }
    return unhandled(request);
  });

const environmentVariableLayer = (client: PrismaManagementClient) =>
  Layer.effect(TestPrismaProviders, Provider.collection([PrismaEnvironmentVariable])).pipe(
    Layer.provideMerge(EnvironmentVariableProvider()),
    Layer.provide(liveProviderContext),
    Layer.provideMerge(clientBackedApi(client).layer),
  );

const customDomainLayer = (client: PrismaManagementClient) =>
  Layer.effect(TestPrismaProviders, Provider.collection([PrismaCustomDomain])).pipe(
    Layer.provideMerge(CustomDomainProvider()),
    Layer.provideMerge(Layer.succeed(PrismaClient, client)),
    Layer.provide(liveProviderContext),
  );

const sourceRepositoryLayer = (client: PrismaManagementClient) =>
  Layer.effect(TestPrismaProviders, Provider.collection([PrismaSourceRepository])).pipe(
    Layer.provideMerge(SourceRepositoryProvider()),
    Layer.provide(liveProviderContext),
    Layer.provideMerge(clientBackedApi(client).layer),
  );

const apiProject = (
  id: string,
  name: string,
  defaultRegion: string | null = "us-east-1",
): ApiProject => ({
  id,
  type: "project",
  url: `https://api.prisma.test/v1/projects/${id}`,
  name,
  createdAt,
  defaultRegion,
  workspace: {
    id: "workspace-1",
    url: "https://api.prisma.test/v1/workspaces/workspace-1",
    name: "team",
  },
});

const apiConnection = (
  databaseId: string,
  connectionId = `connection-${databaseId}`,
): DatabaseConnectionWithSecrets => ({
  id: connectionId,
  type: "connection",
  url: `https://api.prisma.test/v1/connections/${connectionId}`,
  name: "default",
  createdAt,
  kind: "postgres",
  endpoints: {
    direct: {
      host: "db.prisma.test",
      port: 5432,
      connectionString: `postgres://user:password@db.prisma.test/${databaseId}`,
    },
    pooled: {
      host: "pool.prisma.test",
      port: 5432,
      connectionString: `postgres://user:password@pool.prisma.test/${databaseId}`,
    },
  },
  database: {
    id: databaseId,
    url: `https://api.prisma.test/v1/databases/${databaseId}`,
    name: databaseId,
  },
});

it.effect(
  "database credential recovery waits for a ready default connection",
  () => {
    const provisioning: ApiDatabase = {
      ...apiDatabase("database-provisioning", { projectId: "project-1", name: "provisioning" }),
      status: "provisioning",
      defaultConnectionId: null,
      connections: [],
    };
    const ready: ApiDatabase = {
      ...provisioning,
      status: "ready",
      defaultConnectionId: "connection-provisioning",
    };
    let reads = 0;
    let rotations = 0;
    const fake = makeFakeManagementApi((request) => {
      if (request.pathname.startsWith("/v1/databases/")) {
        return data(toWireDatabase(reads++ === 0 ? provisioning : ready));
      }
      if (request.pathname.endsWith("/rotate")) {
        rotations += 1;
        return data(apiConnection(ready.id, ready.defaultConnectionId!));
      }
      return unhandled(request);
    });

    return Effect.gen(function* () {
      const fiber = yield* recoverDatabaseConnectionSecrets(provisioning, {}).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      const recovered = yield* Fiber.join(fiber);
      expect(recovered.database.status).toBe("ready");
      expect(recovered.database.defaultConnectionId).toBe("connection-provisioning");
      expect(Redacted.value(recovered.secrets.directConnectionString!)).toContain(ready.id);
      expect(rotations).toBe(1);
    }).pipe(Effect.provide(fake.layer), Effect.provide(TestClock.layer()));
  },
  { tags: ["unit", "provider:prisma", "provider:prisma:database", "local"] },
);

it.effect(
  "database credential recovery has a bounded status-rich timeout",
  () => {
    const provisioning: ApiDatabase = {
      ...apiDatabase("database-stuck", { projectId: "project-1", name: "stuck" }),
      status: "provisioning",
      defaultConnectionId: null,
      connections: [],
    };
    const fake = makeFakeManagementApi((request) => {
      if (request.pathname.startsWith("/v1/databases/")) {
        return data(toWireDatabase(provisioning));
      }
      if (request.pathname.endsWith("/rotate")) {
        throw new Error("must not rotate while provisioning");
      }
      return unhandled(request);
    });

    return Effect.gen(function* () {
      const fiber = yield* recoverDatabaseConnectionSecrets(provisioning, {}).pipe(
        Effect.result,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 minute");
      const result = yield* Fiber.join(fiber);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("database-stuck");
        expect(String(result.failure)).toContain("provisioning");
        expect(String(result.failure)).toContain("defaultConnectionId 'null'");
      }
    }).pipe(Effect.provide(fake.layer), Effect.provide(TestClock.layer()));
  },
  { tags: ["unit", "provider:prisma", "provider:prisma:database", "local"] },
);

const makeProjectCloud = (initial: ApiProject[] = []) => {
  const projects = new Map(initial.map((project) => [project.id, project]));
  const databases = new Map<string, ApiDatabase>();
  const calls: Array<[string, unknown?]> = [];
  let nextId = initial.length + 1;
  let nextDatabaseId = 1;
  let conflictNextProjectDatabaseCreate = false;
  let staleNextProjectDatabaseObservation = false;
  let staleProjectReads = 0;
  let staleProjectDefaultRegion: string | null = null;
  let staleDatabaseLists = 0;
  let staleDatabases: ApiDatabase[] = [];

  const currentProject = (project: ApiProject) => {
    const database = Array.from(databases.values()).find(
      (database) => database.project.id === project.id && database.isDefault,
    );
    return { ...project, defaultRegion: database?.region?.id ?? null };
  };

  const makeDatabase = (
    project: ApiProject,
    input: { region?: string; isDefault?: boolean },
  ): ApiDatabase => {
    if (input.isDefault) {
      for (const [id, database] of databases) {
        if (database.project.id === project.id && database.isDefault) {
          databases.set(id, { ...database, isDefault: false });
        }
      }
    }
    const id = `project-database-${nextDatabaseId++}`;
    const database: ApiDatabase = {
      id,
      type: "database",
      url: `https://api.prisma.test/v1/databases/${id}`,
      name: project.name,
      status: "ready",
      createdAt,
      isDefault: input.isDefault ?? false,
      defaultConnectionId: `connection-${id}`,
      connections: [apiConnection(id)],
      project: { id: project.id, url: project.url, name: project.name },
      region: { id: input.region ?? "us-east-1", name: input.region ?? "us-east-1" },
      source: { type: "empty" },
      branchId: null,
    };
    databases.set(id, database);
    return database;
  };

  // The same in-memory cloud, served over the wire for the resources that
  // call distilled operations instead of the client above.
  const fake = makeFakeManagementApi((request) => {
    const segments = request.pathname.split("/").filter((s) => s.length > 0);

    if (request.pathname === "/v1/services" && request.method === "GET") {
      calls.push(["listApps", Object.fromEntries(new URLSearchParams(request.search))]);
      return page([]);
    }

    if (request.pathname === "/v1/projects" && request.method === "GET") {
      calls.push(["listProjects"]);
      return page(Array.from(projects.values()).map(currentProject).map(toWireProject));
    }

    if (request.pathname === "/v1/projects" && request.method === "POST") {
      const input = request.bodyJson as {
        name?: string;
        region?: string;
        createDatabase?: boolean;
      };
      calls.push(["createProject", input]);
      const id = `project-${nextId++}`;
      const project = apiProject(id, input.name ?? `project-${id}`, null);
      projects.set(id, project);
      const database =
        input.createDatabase === false
          ? null
          : makeDatabase(project, { region: input.region, isDefault: true });
      return data(
        {
          ...toWireProject(currentProject(project)),
          database: database === null ? null : toWireCreatedDatabase(database),
        },
        { status: 201 },
      );
    }

    if (segments.length === 3 && segments[1] === "projects") {
      const id = segments[2]!;
      if (request.method === "GET") {
        calls.push(["getProject", id]);
        const stored = projects.get(id);
        const project = stored
          ? staleProjectReads > 0
            ? { ...currentProject(stored), defaultRegion: staleProjectDefaultRegion }
            : currentProject(stored)
          : undefined;
        if (staleProjectReads > 0) staleProjectReads -= 1;
        return project === undefined ? notFound("not found") : data(toWireProject(project));
      }
      if (request.method === "PATCH") {
        const input = request.bodyJson as { name?: string; settings?: Record<string, unknown> };
        calls.push(["updateProject", { id, input }]);
        const project = projects.get(id)!;
        const updated = { ...project, name: input.name ?? project.name };
        projects.set(id, updated);
        return data(toWireProject(currentProject(updated)));
      }
      if (request.method === "DELETE") {
        calls.push(["deleteProject", id]);
        projects.delete(id);
        for (const [databaseId, database] of databases) {
          if (database.project.id === id) databases.delete(databaseId);
        }
        return json(null, { status: 204 });
      }
    }

    if (segments.length === 4 && segments[1] === "projects" && segments[3] === "databases") {
      const projectId = segments[2]!;
      if (request.method === "GET") {
        calls.push(["listProjectDatabases", projectId]);
        if (staleDatabaseLists > 0) {
          staleDatabaseLists -= 1;
          return page(staleDatabases.map(toWireDatabase));
        }
        return page(
          Array.from(databases.values())
            .filter((database) => database.project.id === projectId)
            .map(toWireDatabase),
        );
      }
      if (request.method === "POST") {
        const input = request.bodyJson as { region?: string; isDefault?: boolean };
        calls.push(["createProjectDatabase", { projectId, input }]);
        if (conflictNextProjectDatabaseCreate) {
          conflictNextProjectDatabaseCreate = false;
          return conflict("default database promotion in progress");
        }
        const previousDefault = Array.from(databases.values()).find(
          (database) => database.project.id === projectId && database.isDefault,
        );
        const created = makeDatabase(projects.get(projectId)!, input);
        if (staleNextProjectDatabaseObservation) {
          staleNextProjectDatabaseObservation = false;
          staleProjectReads = 1;
          staleProjectDefaultRegion = previousDefault?.region?.id ?? null;
          staleDatabaseLists = 1;
          staleDatabases = Array.from(databases.values())
            .filter((database) => database.project.id === projectId)
            .map((database) => ({ ...database, isDefault: database.id === previousDefault?.id }));
        }
        return data(toWireCreatedDatabase(created), { status: 201 });
      }
    }

    if (segments.length === 3 && segments[1] === "databases") {
      const id = segments[2]!;
      if (request.method === "GET") {
        calls.push(["getDatabase", id]);
        const database = databases.get(id);
        return database === undefined ? notFound("not found") : data(toWireDatabase(database));
      }
      if (request.method === "DELETE") {
        calls.push(["deleteDatabase", id]);
        databases.delete(id);
        return json(null, { status: 204 });
      }
    }

    if (
      segments.length === 4 &&
      segments[1] === "connections" &&
      segments[3] === "rotate" &&
      request.method === "POST"
    ) {
      const id = segments[2]!;
      calls.push(["rotateConnection", id]);
      const database = Array.from(databases.values()).find(
        (candidate) => candidate.defaultConnectionId === id,
      )!;
      return data(apiConnection(database.id, id));
    }

    return unhandled(request);
  });

  return {
    fake,
    calls,
    databases,
    projects,
    conflictNextProjectDatabaseCreate: () => {
      conflictNextProjectDatabaseCreate = true;
    },
    staleNextProjectDatabaseObservation: () => {
      staleNextProjectDatabaseObservation = true;
    },
  };
};

const foreignProject = apiProject("project-foreign", "app");

const adoptionCloud = makeProjectCloud([foreignProject]);
const adoption = Test.make({ providers: projectLayer(adoptionCloud.fake), adopt: true });

adoption.test.provider(
  "Plan adopts explicitly and applies write-only project settings",
  (stack) =>
    Effect.gen(function* () {
      adoptionCloud.projects.clear();
      adoptionCloud.projects.set(foreignProject.id, foreignProject);
      adoptionCloud.calls.length = 0;
      yield* stack.destroy();

      const project = yield* stack.deploy(
        PrismaProject("Project", {
          name: "app",
          createDatabase: true,
          region: "us-east-1",
          settings: {},
        }),
      );

      expect(project.projectId).toBe("project-foreign");
      expect(adoptionCloud.calls).toContainEqual([
        "updateProject",
        { id: "project-foreign", input: { name: "app", settings: {} } },
      ]);

      yield* stack.destroy();
    }),
  {
    tags: [
      "unit",
      "provider:prisma",
      "provider:prisma:database",
      "provider:prisma:project",
      "local",
    ],
  },
);

const eventuallyConsistentRegionCloud = makeProjectCloud();
const eventuallyConsistentRegion = Test.make({
  providers: projectLayer(eventuallyConsistentRegionCloud.fake),
});

eventuallyConsistentRegion.test.provider(
  "Project default database creation retries one stale observation",
  (stack) =>
    Effect.gen(function* () {
      eventuallyConsistentRegionCloud.projects.clear();
      eventuallyConsistentRegionCloud.databases.clear();
      yield* stack.destroy();

      const first = yield* stack.deploy(
        PrismaProject("Project", { name: "app", createDatabase: false }),
      );
      eventuallyConsistentRegionCloud.calls.length = 0;
      eventuallyConsistentRegionCloud.staleNextProjectDatabaseObservation();
      const second = yield* stack.deploy(
        PrismaProject("Project", {
          name: "app",
          createDatabase: true,
          region: "us-west-1" as const,
        }),
      );

      expect(second.projectId).toBe(first.projectId);
      expect(second.defaultRegion).toBe("us-west-1");
      expect(Redacted.value(second.directConnectionString!)).toContain(second.databaseId!);
      expect(
        eventuallyConsistentRegionCloud.calls.filter(([operation]) => operation === "getProject")
          .length,
      ).toBeGreaterThanOrEqual(3);
      expect(
        eventuallyConsistentRegionCloud.calls.filter(
          ([operation]) => operation === "listProjectDatabases",
        ).length,
      ).toBeGreaterThanOrEqual(3);

      yield* stack.destroy();
    }),
  {
    tags: [
      "unit",
      "provider:prisma",
      "provider:prisma:database",
      "provider:prisma:project",
      "local",
    ],
  },
);

const conflictingRegionCloud = makeProjectCloud();
const conflictingRegion = Test.make({ providers: projectLayer(conflictingRegionCloud.fake) });

conflictingRegion.test.provider(
  "Project default database creation rejects a conflict without an observed default",
  (stack) =>
    Effect.gen(function* () {
      conflictingRegionCloud.projects.clear();
      conflictingRegionCloud.databases.clear();
      yield* stack.destroy();

      const first = yield* stack.deploy(
        PrismaProject("Project", { name: "app", createDatabase: false }),
      );
      conflictingRegionCloud.calls.length = 0;
      conflictingRegionCloud.conflictNextProjectDatabaseCreate();

      const result = yield* stack
        .deploy(
          PrismaProject("Project", {
            name: "app",
            createDatabase: true,
            region: "us-west-1" as const,
          }),
        )
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("does not expose the requested default database");
      }
      expect(first.databaseId).toBeUndefined();
      expect(conflictingRegionCloud.databases.size).toBe(0);
      expect(conflictingRegionCloud.calls.map(([operation]) => operation)).not.toContain(
        "deleteDatabase",
      );

      conflictingRegionCloud.databases.clear();
      yield* stack.destroy();
    }),
  {
    tags: [
      "unit",
      "provider:prisma",
      "provider:prisma:database",
      "provider:prisma:project",
      "local",
    ],
  },
);

const switchedDefaultCloud = makeProjectCloud();
const switchedDefault = Test.make({ providers: projectLayer(switchedDefaultCloud.fake) });

// The live API rejects a second default database ("Default database already
// exists") and has no promote-existing operation, so a default switched by
// another client is only reachable in the fake cloud.
switchedDefault.test.provider(
  "Project create recovery follows a switched default database and rotates its credentials",
  (stack) =>
    Effect.gen(function* () {
      switchedDefaultCloud.projects.clear();
      switchedDefaultCloud.databases.clear();
      yield* stack.destroy();

      const project = PrismaProject("Project", { createDatabase: true });
      const initial = yield* stack.deploy(project);
      expect(initial.databaseId).toBeDefined();

      for (const [id, database] of switchedDefaultCloud.databases) {
        switchedDefaultCloud.databases.set(id, { ...database, isDefault: false });
      }
      switchedDefaultCloud.databases.set("database-new-default", {
        ...apiDatabase("database-new-default", {
          projectId: initial.projectId,
          name: "new-default",
          isDefault: true,
        }),
        connections: [],
      });

      yield* markCreating(stack, "Project");
      switchedDefaultCloud.calls.length = 0;
      const recovered = yield* stack.deploy(project);
      expect(recovered.projectId).toBe(initial.projectId);
      expect(recovered.databaseId).toBe("database-new-default");
      expect(Redacted.value(recovered.directConnectionString!)).toContain("database-new-default");
      expect(switchedDefaultCloud.calls).toContainEqual([
        "rotateConnection",
        "connection-database-new-default",
      ]);

      yield* stack.destroy();
      expect(switchedDefaultCloud.projects.has(initial.projectId)).toBe(false);
    }),
  {
    tags: [
      "unit",
      "provider:prisma",
      "provider:prisma:database",
      "provider:prisma:project",
      "local",
    ],
  },
);

const apiDatabase = (
  id: string,
  input: {
    projectId: string;
    name?: string;
    region?: string;
    isDefault?: boolean;
    source?: ApiDatabase["source"];
  },
): ApiDatabase => ({
  id,
  type: "database",
  url: `https://api.prisma.test/v1/databases/${id}`,
  name: input.name ?? `database-${id}`,
  status: "ready",
  createdAt,
  isDefault: input.isDefault ?? false,
  defaultConnectionId: `connection-${id}`,
  connections: [apiConnection(id)],
  project: {
    id: input.projectId,
    url: `https://api.prisma.test/v1/projects/${input.projectId}`,
    name: "app",
  },
  region: { id: input.region ?? "us-east-1", name: "Region" },
  source: input.source ?? { type: "empty" },
  branchId: null,
});

const makeDatabaseCloud = () => {
  const databases = new Map<string, ApiDatabase>();
  const calls: Array<[string, unknown?]> = [];
  let nextId = 1;
  // The same in-memory cloud, served over the wire for the Database resource.
  const fake = makeFakeManagementApi((request) => {
    const segments = request.pathname.split("/").filter((s) => s.length > 0);

    if (request.pathname === "/v1/databases" && request.method === "GET") {
      return page(Array.from(databases.values()).map(toWireDatabase));
    }
    if (request.pathname === "/v1/databases" && request.method === "POST") {
      const input = request.bodyJson as {
        projectId: string;
        name?: string;
        region?: string;
        isDefault?: boolean;
        source?: ApiDatabase["source"];
      };
      calls.push(["createDatabase", input]);
      if (input.isDefault) {
        for (const [id, database] of databases) {
          if (database.project.id === input.projectId && database.isDefault) {
            databases.set(id, { ...database, isDefault: false });
          }
        }
      }
      const id = `database-${nextId++}`;
      const database = apiDatabase(id, input);
      databases.set(id, database);
      return data(toWireCreatedDatabase(database), { status: 201 });
    }

    // No branches: the logical-ID lookup resolves no branch and falls back to the name.
    if (
      segments.length === 4 &&
      segments[1] === "projects" &&
      segments[3] === "branches" &&
      request.method === "GET"
    ) {
      return page([]);
    }

    if (
      segments.length === 4 &&
      segments[1] === "projects" &&
      segments[3] === "databases" &&
      request.method === "GET"
    ) {
      const projectId = segments[2]!;
      return page(
        Array.from(databases.values())
          .filter((database) => database.project.id === projectId)
          .map(toWireDatabase),
      );
    }

    if (segments.length === 3 && segments[1] === "databases") {
      const id = segments[2]!;
      if (request.method === "GET") {
        calls.push(["getDatabase", id]);
        const database = databases.get(id);
        return database === undefined ? notFound("not found") : data(toWireDatabase(database));
      }
      if (request.method === "PATCH") {
        const input = request.bodyJson as { name?: string };
        const database = databases.get(id)!;
        const updated = { ...database, name: input.name ?? database.name };
        databases.set(id, updated);
        return data(toWireDatabase(updated));
      }
      if (request.method === "DELETE") {
        calls.push(["deleteDatabase", id]);
        databases.delete(id);
        return json(null, { status: 204 });
      }
    }

    if (
      segments.length === 4 &&
      segments[1] === "connections" &&
      segments[3] === "rotate" &&
      request.method === "POST"
    ) {
      const id = segments[2]!;
      calls.push(["rotateConnection", id]);
      const database = Array.from(databases.values()).find(
        (candidate) => candidate.defaultConnectionId === id,
      )!;
      return data(apiConnection(database.id, id));
    }

    return unhandled(request);
  });

  return { fake, calls, databases };
};

const inheritedRegionCloud = makeDatabaseCloud();
const inheritedRegion = Test.make({ providers: databaseLayer(inheritedRegionCloud.fake) });

inheritedRegion.test.provider(
  "Database region inherit is stable and follows the project default region",
  (stack) =>
    Effect.gen(function* () {
      inheritedRegionCloud.databases.clear();
      yield* stack.destroy();
      inheritedRegionCloud.databases.set(
        "project-default",
        apiDatabase("project-default", {
          projectId: "project-1",
          name: "project-default",
          region: "us-east-1",
          isDefault: true,
        }),
      );

      const first = yield* stack.deploy(
        PrismaDatabase("Database", { project: "project-1", name: "inherited", region: "inherit" }),
      );
      expect(first.region).toBe("us-east-1");

      inheritedRegionCloud.calls.length = 0;
      const second = yield* stack.deploy(
        PrismaDatabase("Database", { project: "project-1", name: "inherited", region: "inherit" }),
      );
      expect(second.databaseId).toBe(first.databaseId);
      expect(inheritedRegionCloud.calls.map(([operation]) => operation)).not.toContain(
        "createDatabase",
      );

      inheritedRegionCloud.databases.set("project-default", {
        ...inheritedRegionCloud.databases.get("project-default")!,
        region: { id: "us-west-1", name: "US West" },
      });
      inheritedRegionCloud.calls.length = 0;
      const moved = yield* stack.deploy(
        PrismaDatabase("Database", { project: "project-1", name: "inherited", region: "inherit" }),
      );
      expect(moved.databaseId).not.toBe(first.databaseId);
      expect(moved.region).toBe("us-west-1");
      expect(inheritedRegionCloud.calls.map(([operation]) => operation)).toContain(
        "createDatabase",
      );

      yield* stack.destroy();
      inheritedRegionCloud.databases.clear();
    }),
  { tags: ["unit", "provider:prisma", "provider:prisma:database", "local"] },
);

const environmentVariable = {
  id: "env-1",
  type: "environment-variable" as const,
  url: "https://api.prisma.test/v1/environment-variables/env-1",
  projectId: "project-1",
  branchId: null,
  class: "production" as const,
  key: "TOKEN",
  valueKid: "kid-1",
  isManagedBySystem: false,
  createdAt,
  updatedAt: createdAt,
};
const environmentSecrets = new Map([[environmentVariable.id, "foreign"]]);
const environmentCalls: Array<[string, unknown?]> = [];
const environmentClient = {
  listEnvironmentVariables: () => Effect.succeed([environmentVariable]),
  getEnvironmentVariable: (id: string) => Effect.succeed({ ...environmentVariable, id }),
  createEnvironmentVariable: () =>
    Effect.fail(
      new PrismaApiError({
        method: "POST",
        path: "/v1/environment-variables",
        status: 409,
        message: "already exists",
      }),
    ),
  updateEnvironmentVariable: (id: string, input: { value: string }) =>
    Effect.sync(() => {
      environmentCalls.push(["updateEnvironmentVariable", { id, input }]);
      environmentSecrets.set(id, input.value);
      return { ...environmentVariable, id };
    }),
  deleteEnvironmentVariable: (id: string) =>
    Effect.sync(() => {
      environmentSecrets.delete(id);
    }),
} as unknown as PrismaManagementClient;
const environmentAdoption = Test.make({
  providers: environmentVariableLayer(environmentClient),
  adopt: true,
});

environmentAdoption.test.provider(
  "adoption and ordinary deploys always converge write-only environment secrets",
  (stack) =>
    Effect.gen(function* () {
      environmentSecrets.clear();
      environmentSecrets.set(environmentVariable.id, "foreign");
      environmentCalls.length = 0;
      yield* stack.destroy();

      const deploy = () =>
        stack.deploy(
          PrismaEnvironmentVariable("Token", {
            project: "project-1",
            class: "production",
            key: "TOKEN",
            value: Redacted.make("desired"),
          }),
        );

      yield* deploy();
      expect(environmentSecrets.get("env-1")).toBe("desired");

      environmentSecrets.set("env-1", "externally-drifted");
      yield* deploy();
      expect(environmentSecrets.get("env-1")).toBe("desired");
      expect(
        environmentCalls.filter(([operation]) => operation === "updateEnvironmentVariable"),
      ).toHaveLength(2);

      yield* stack.destroy();
    }),
  { tags: ["unit", "provider:prisma", "provider:prisma:environmentvariable", "local"] },
);

const customDomainCalls: Array<[string, unknown?]> = [];
const customDomainCloud = new Map<string, ApiCustomDomain>();
let nextCustomDomainId = 1;
const customDomainClient = {
  listAppDomains: (appId: string) =>
    Effect.sync(() => {
      customDomainCalls.push(["listAppDomains", appId]);
      return Array.from(customDomainCloud.values()).filter((domain) => domain.appId === appId);
    }),
  getCustomDomain: (id: string) =>
    Effect.suspend(() => {
      const domain = customDomainCloud.get(id);
      return domain
        ? Effect.succeed(domain)
        : Effect.fail(
            new PrismaApiError({
              method: "GET",
              path: `/v1/domains/${id}`,
              status: 404,
              message: "not found",
            }),
          );
    }),
  getApp: (appId: string) =>
    Effect.sync(() => {
      customDomainCalls.push(["getApp", appId]);
      return {
        id: appId,
        type: "app" as const,
        url: `https://api.prisma.test/v1/services/${appId}`,
        name: "api",
        region: { id: "us-east-1", name: "US East" },
        projectId: "project-1",
        branchId: "branch-1",
        latestDeploymentId: null,
        appEndpointDomain: "api.prisma.build",
        createdAt,
      };
    }),
  getBranch: (branchId: string) =>
    Effect.succeed({
      id: branchId,
      type: "branch" as const,
      url: `https://api.prisma.test/v1/branches/${branchId}`,
      gitName: "main",
      isDefault: true,
      role: "production" as const,
      createdAt,
      updatedAt: createdAt,
      project: {
        id: "project-1",
        url: "https://api.prisma.test/v1/projects/project-1",
        name: "app",
      },
    }),
  createAppDomain: (appId: string, input: { hostname: string }) =>
    Effect.sync(() => {
      customDomainCalls.push(["createAppDomain", { appId, input }]);
      const id = `domain-${nextCustomDomainId++}`;
      const domain: ApiCustomDomain = {
        id,
        type: "custom-domain" as const,
        url: `https://api.prisma.test/v1/domains/${id}`,
        hostname: input.hostname,
        appId,
        status: "pending_dns" as const,
        foundryStatus: "pending",
        failureReason: null,
        failureCategory: null,
        certExpiresAt: null,
        dnsRecords: [
          { type: "CNAME" as const, name: input.hostname, value: "api.prisma.build", ttl: null },
        ],
        createdAt,
        updatedAt: createdAt,
      };
      customDomainCloud.set(id, domain);
      return { status: 201 as const, domain };
    }),
  retryCustomDomain: (id: string) =>
    Effect.sync(() => {
      customDomainCalls.push(["retryCustomDomain", id]);
      const domain = customDomainCloud.get(id)!;
      const retried: ApiCustomDomain = {
        ...domain,
        status: "verifying",
        foundryStatus: "provisioning",
        failureReason: null,
        failureCategory: null,
        updatedAt: createdAt,
      };
      customDomainCloud.set(id, retried);
      return retried;
    }),
  deleteCustomDomain: (id: string) =>
    Effect.sync(() => {
      customDomainCalls.push(["deleteCustomDomain", id]);
      customDomainCloud.delete(id);
    }),
} as unknown as PrismaManagementClient;
const customDomains = Test.make({ providers: customDomainLayer(customDomainClient) });

const domainResource = (app = "app-1", hostname = "new.example.com") =>
  PrismaCustomDomain("Domain", { app, hostname });

customDomains.test.provider(
  "custom domains use the canonical App API and exact status fields",
  (stack) =>
    Effect.gen(function* () {
      customDomainCalls.length = 0;
      customDomainCloud.clear();
      nextCustomDomainId = 1;
      yield* stack.destroy();

      const domain = yield* stack.deploy(domainResource("app-1", "NEW.EXAMPLE.COM."));

      expect(domain.appId).toBe("app-1");
      expect(domain.hostname).toBe("new.example.com");
      expect(domain.foundryStatus).toBe("pending");
      expect(customDomainCalls).toContainEqual(["listAppDomains", "app-1"]);
      expect(customDomainCalls).toContainEqual([
        "createAppDomain",
        { appId: "app-1", input: { hostname: "new.example.com" } },
      ]);

      // A failed Foundry attempt. The engine plans from persisted attributes,
      // so record the observed failure in state as well as in the cloud.
      const failedStatus: Pick<
        ApiCustomDomain,
        "status" | "foundryStatus" | "failureReason" | "failureCategory"
      > = {
        status: "failed",
        foundryStatus: "failed",
        failureReason: "DNS verification failed",
        failureCategory: "dns",
      };
      customDomainCloud.set(domain.customDomainId, {
        ...customDomainCloud.get(domain.customDomainId)!,
        ...failedStatus,
      });
      yield* patchSettledAttr(stack, "Domain", failedStatus);
      expect((yield* stack.plan(domainResource())).resources.Domain?.action).toBe("update");

      customDomainCalls.length = 0;
      const retried = yield* stack.deploy(domainResource());
      expect(retried.customDomainId).toBe(domain.customDomainId);
      expect(retried.status).toBe("verifying");
      expect(customDomainCalls.filter(([operation]) => operation === "retryCustomDomain")).toEqual([
        ["retryCustomDomain", domain.customDomainId],
      ]);

      yield* patchSettledAttr(stack, "Domain", { status: "active" });
      expect((yield* stack.plan(domainResource())).resources.Domain?.action).toBe("noop");

      customDomainCalls.length = 0;
      const moved = yield* failureOf(stack.deploy(domainResource("app-2")));
      expect(moved.text).toContain("cannot atomically replace");
      const renamed = yield* failureOf(stack.deploy(domainResource("app-1", "other.example.com")));
      expect(renamed.text).toContain("cannot atomically replace");
      expect(customDomainCalls).toEqual([]);

      // State claims app-2 but the persisted domain ID resolves to app-1:
      // reconcile must refuse instead of claiming convergence.
      yield* patchSettledAttr(stack, "Domain", { appId: "app-2", status: "failed" });
      const mismatch = yield* failureOf(stack.deploy(domainResource("app-2")));
      expect(mismatch.text).toContain("Refusing to claim convergence");
      expect(customDomainCalls.map(([operation]) => operation)).not.toContain("retryCustomDomain");

      // Align the cloud with the persisted identity so destroy can delete it.
      customDomainCloud.set(domain.customDomainId, {
        ...customDomainCloud.get(domain.customDomainId)!,
        appId: "app-2",
      });
      yield* stack.destroy();
      expect(customDomainCloud.has(domain.customDomainId)).toBe(false);
    }),
  {
    tags: [
      "unit",
      "provider:prisma",
      "provider:prisma:app",
      "provider:prisma:customdomain",
      "local",
    ],
  },
);

const sourceRepositoryCloud = new Map<string, ApiSourceRepository>();
const sourceRepositoryCalls: Array<[string, unknown?]> = [];
let nextSourceRepositoryId = 1;
const sourceRepositoryClient = {
  listProjects: () =>
    Effect.succeed([apiProject("project-1", "one", null), apiProject("project-2", "two", null)]),
  listSourceRepositories: ({ projectId }: { projectId: string }) =>
    Effect.succeed(
      Array.from(sourceRepositoryCloud.values()).filter(
        (repository) => repository.projectId === projectId && repository.status === "active",
      ),
    ),
  listApps: () => Effect.succeed([]),
  listProjectDatabases: () => Effect.succeed([]),
  listBranches: (projectId: string) =>
    Effect.succeed([
      {
        id: `branch-${projectId}`,
        type: "branch" as const,
        url: `https://api.prisma.test/v1/branches/branch-${projectId}`,
        gitName: "main",
        isDefault: true,
        role: "production" as const,
        createdAt,
        updatedAt: createdAt,
        project: {
          id: projectId,
          url: `https://api.prisma.test/v1/projects/${projectId}`,
          name: projectId,
        },
      },
    ]),
  getSourceRepository: (id: string) =>
    Effect.suspend(() => {
      const repository = sourceRepositoryCloud.get(id);
      return repository?.status === "active"
        ? Effect.succeed(repository)
        : Effect.fail(
            new PrismaApiError({
              method: "GET",
              path: `/v1/source-repositories/${id}`,
              status: 404,
              message: "not found",
            }),
          );
    }),
  createSourceRepository: (input: {
    projectId: string;
    provider: "github";
    providerRepositoryId: number;
    installationId?: string;
  }) =>
    Effect.suspend(() => {
      sourceRepositoryCalls.push(["createSourceRepository", input]);
      const conflict = Array.from(sourceRepositoryCloud.values()).some(
        (repository) =>
          repository.status === "active" &&
          (repository.projectId === input.projectId ||
            repository.repoId === input.providerRepositoryId),
      );
      if (conflict) {
        return Effect.fail(
          new PrismaApiError({
            method: "POST",
            path: "/v1/source-repositories",
            status: 409,
            message: "already linked",
          }),
        );
      }
      const id = `source-${nextSourceRepositoryId++}`;
      const repository: ApiSourceRepository = {
        id,
        type: "source-repository",
        url: `https://api.prisma.test/v1/source-repositories/${id}`,
        repoId: input.providerRepositoryId,
        provider: input.provider,
        repoFullName: `owner/repo-${input.providerRepositoryId}`,
        defaultBranch: "main",
        isPrivate: false,
        status: "active",
        projectId: input.projectId,
        installationId: input.installationId ?? "installation-auto",
        createdAt,
        updatedAt: createdAt,
      };
      sourceRepositoryCloud.set(id, repository);
      return Effect.succeed(repository);
    }),
  deleteSourceRepository: (id: string) =>
    Effect.sync(() => {
      sourceRepositoryCalls.push(["deleteSourceRepository", id]);
      const repository = sourceRepositoryCloud.get(id);
      if (repository) {
        sourceRepositoryCloud.set(id, { ...repository, status: "archived" });
      }
    }),
} as unknown as PrismaManagementClient;
const sourceRepositories = Test.make({ providers: sourceRepositoryLayer(sourceRepositoryClient) });

sourceRepositories.test.provider(
  "source repository links reject non-atomic relinks without mutating the live link",
  (stack) =>
    Effect.gen(function* () {
      sourceRepositoryCloud.clear();
      sourceRepositoryCalls.length = 0;
      nextSourceRepositoryId = 1;
      yield* stack.destroy();

      const repository = (project: string, providerRepositoryId: number) =>
        PrismaSourceRepository("Repository", { project, providerRepositoryId });

      const first = yield* stack.deploy(repository("project-1", 123));
      sourceRepositoryCalls.length = 0;
      const relink = yield* failureOf(stack.deploy(repository("project-2", 456)));
      expect(relink.text).toContain("cannot be replaced atomically");
      expect(sourceRepositoryCalls).toEqual([]);
      expect(sourceRepositoryCloud.get(first.sourceRepositoryId)?.status).toBe("active");

      // An archived link is an observed mismatch the diff refuses to relink.
      yield* patchStateAttr(stack, "Repository", { status: "archived" });
      const archived = yield* failureOf(stack.plan(repository("project-1", 123)));
      expect(archived.text).toContain("cannot be replaced atomically");
      yield* patchStateAttr(stack, "Repository", { status: "active" });

      yield* stack.destroy();
      expect(sourceRepositoryCloud.get(first.sourceRepositoryId)?.status).toBe("archived");
    }),
  {
    tags: [
      "unit",
      "provider:prisma",
      "provider:prisma:project",
      "provider:prisma:sourcerepository",
      "local",
    ],
  },
);

const branchCloud = new Map<string, ApiBranch>();
const branchCalls: Array<[string, unknown?]> = [];
let nextBranchId = 1;

// An in-memory branch cloud, served over the wire.
const branchFake = makeFakeManagementApi((request) => {
  const segments = request.pathname.split("/").filter((s) => s.length > 0);

  if (request.pathname === "/v1/projects" && request.method === "GET") {
    return page([toWireProject(apiProject("project-1", "app"))]);
  }

  if (segments.length === 4 && segments[1] === "projects" && segments[3] === "branches") {
    const projectId = segments[2]!;
    if (request.method === "GET") {
      const gitName = request.search.includes("gitName=")
        ? new URLSearchParams(request.search).get("gitName")
        : null;
      return page(
        Array.from(branchCloud.values()).filter(
          (branch) => gitName === null || branch.gitName === gitName,
        ),
      );
    }
    if (request.method === "POST") {
      const input = request.bodyJson as { gitName: string; isDefault?: boolean };
      branchCalls.push(["createBranch", { projectId, input }]);
      const first = branchCloud.size === 0;
      const makeDefault = first || input.isDefault === true;
      if (makeDefault) {
        for (const [id, branch] of branchCloud) {
          branchCloud.set(id, { ...branch, isDefault: false });
        }
      }
      const id = `branch-${nextBranchId++}`;
      const branch = {
        id,
        type: "branch" as const,
        url: `https://api.prisma.test/v1/branches/${id}`,
        gitName: input.gitName,
        isDefault: makeDefault,
        role: first ? ("production" as const) : ("preview" as const),
        createdAt,
        updatedAt: createdAt,
        project: {
          id: projectId,
          url: `https://api.prisma.test/v1/projects/${projectId}`,
          name: "app",
        },
      };
      branchCloud.set(id, branch);
      return data(branch, { status: 201 });
    }
  }

  if (segments.length === 3 && segments[1] === "branches") {
    const id = segments[2]!;
    if (request.method === "GET") {
      const branch = branchCloud.get(id);
      return branch === undefined ? notFound("not found") : data(branch);
    }
    if (request.method === "PATCH") {
      const input = request.bodyJson as { isDefault?: boolean | null };
      branchCalls.push(["updateBranch", { id, input }]);
      if (input.isDefault !== true) {
        throw new Error("the Management API rejects default demotion");
      }
      for (const [branchId, branch] of branchCloud) {
        branchCloud.set(branchId, { ...branch, isDefault: branchId === id });
      }
      return data(branchCloud.get(id)!);
    }
    if (request.method === "DELETE") {
      branchCalls.push(["deleteBranch", id]);
      branchCloud.delete(id);
      return json(null, { status: 204 });
    }
  }

  return unhandled(request);
});

const branches = Test.make({ providers: branchLayer(branchFake) });

const fakeBranch = (
  id: string,
  gitName: string,
  isDefault: boolean,
  role: ApiBranch["role"],
): ApiBranch => ({
  id,
  type: "branch",
  url: `https://api.prisma.test/v1/branches/${id}`,
  gitName,
  isDefault,
  role,
  createdAt,
  updatedAt: createdAt,
  project: {
    id: "project-1",
    url: "https://api.prisma.test/v1/projects/project-1",
    name: "app",
  },
});

branches.test.provider(
  "Branch refuses to create a project's first branch and list omits undeletable branches",
  (stack) =>
    Effect.gen(function* () {
      branchCloud.clear();
      branchCalls.length = 0;
      nextBranchId = 1;
      yield* stack.destroy();

      // A project with no default branch: the API would make this branch the
      // undeletable production branch, so the create must be refused.
      const unsafe = yield* failureOf(
        stack.deploy(
          PrismaBranch("UnsafeFirst", { project: "project-1", gitName: "main", isDefault: false }),
        ),
      );
      expect(unsafe.text).toContain("undeletable production branch");
      expect(branchCalls.map(([operation]) => operation)).not.toContain("createBranch");

      // Defaults and production-role branches are project-owned; nuke must
      // only see deletable branches.
      for (const branch of [
        fakeBranch("branch-main", "main", false, "production"),
        fakeBranch("branch-promoted", "promoted", true, "preview"),
        fakeBranch("branch-feature", "feature", false, "preview"),
      ]) {
        branchCloud.set(branch.id, branch);
      }
      const provider = yield* Provider.findProvider(PrismaBranch);
      expect((yield* provider.list()).map((branch) => branch.branchId)).toEqual(["branch-feature"]);

      branchCloud.clear();
      yield* stack.destroy();
    }),
  {
    tags: ["unit", "provider:prisma", "provider:prisma:branch", "provider:prisma:project", "local"],
  },
);

// ---------------------------------------------------------------------------
// Live: the same lifecycle paths against the real Prisma Management API.
// ---------------------------------------------------------------------------

const live = Test.make({ providers: Prisma.providers() });

const liveTags = (...resources: string[]) => [
  "provider:prisma",
  ...resources.map((resource) => `provider:prisma:${resource}`),
  "live",
];

const projectDatabases = (projectId: string) =>
  getProjectDatabases({ projectId }).pipe(Effect.map((response) => response.data));

const expectDatabaseGone = (databaseId: string) =>
  expectGone(
    getDatabase({ databaseId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

const expectBranchGone = (branchId: string) =>
  expectGone(
    getBranch({ branchId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

const expectEnvironmentVariableGone = (envVarId: string) =>
  expectGone(
    getEnvironmentVariable({ envVarId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

const isOwnedBySomeoneElse = (failure: { errors: unknown[] }) =>
  failure.errors.some((error) => error instanceof OwnedBySomeoneElse);

live.test.provider(
  "refuses cold adoption of a named project after lost state, then adopts it explicitly",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = `alchemy-lifecycle-adopt-${stack.stage}`;
      const project = PrismaProject("Project", { name, createDatabase: false });

      const initial = yield* stack.deploy(project);
      yield* forgetState(stack, "Project");

      const refused = yield* failureOf(stack.deploy(project));
      expect(isOwnedBySomeoneElse(refused)).toBe(true);
      expect((yield* getProject({ id: initial.projectId })).data.name).toBe(name);

      const adopted = yield* stack.deploy(project.pipe(adopt(true)));
      expect(adopted.projectId).toBe(initial.projectId);
      expect(adopted.projectName).toBe(name);

      yield* stack.destroy();
      yield* expectProjectGone(initial.projectId);
    }),
  { tags: liveTags("project"), timeout: 240_000 },
);

live.test.provider(
  "adds a missing default database in place and refuses an in-place region change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bare = yield* stack.deploy(PrismaProject("Project", { createDatabase: false }));
      expect(bare.databaseId).toBeUndefined();

      const withDefault = yield* stack.deploy(PrismaProject("Project", { createDatabase: true }));
      expect(withDefault.projectId).toBe(bare.projectId);
      expect(withDefault.databaseId).toBeDefined();
      expect(withDefault.defaultRegion).toBe("us-east-1");
      expect(withDefault.directConnectionString).toBeDefined();
      const defaults = (yield* projectDatabases(bare.projectId)).filter((db) => db.isDefault);
      expect(defaults.map((db) => db.id)).toEqual([withDefault.databaseId]);

      const moved = yield* failureOf(
        stack.deploy(PrismaProject("Project", { createDatabase: true, region: "eu-central-1" })),
      );
      expect(moved.text).toContain("Cannot safely change");
      expect(moved.text).toContain("explicit data migration");
      const after = yield* projectDatabases(bare.projectId);
      expect(after.map((db) => db.id)).toEqual([withDefault.databaseId]);
      expect(after[0]?.region?.id).toBe("us-east-1");

      yield* stack.destroy();
      yield* expectProjectGone(bare.projectId);
    }),
  { tags: liveTags("database", "project"), timeout: 240_000 },
);

live.test.provider(
  "replaces a named project delete-first when its last default database is removed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = `alchemy-lifecycle-replace-${stack.stage}`;

      const first = yield* stack.deploy(PrismaProject("Project", { name, createDatabase: true }));
      expect(first.databaseId).toBeDefined();

      const without = PrismaProject("Project", { name, createDatabase: false });
      const node = (yield* stack.plan(without)).resources.Project;
      expect(node?.action).toBe("replace");
      if (node?.action === "replace") {
        expect(node.deleteFirst).toBe(true);
      }

      const second = yield* stack.deploy(without);
      expect(second.projectId).not.toBe(first.projectId);
      expect(second.databaseId).toBeUndefined();
      yield* expectProjectGone(first.projectId);

      yield* stack.destroy();
      yield* expectProjectGone(second.projectId);
    }),
  { tags: liveTags("database", "project"), timeout: 240_000 },
);

live.test.provider(
  "an out-of-band default database blocks reconciling a project as createDatabase: false",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bare = yield* stack.deploy(PrismaProject("Project", { createDatabase: false }));
      yield* createProjectDatabase({
        projectId: bare.projectId,
        region: "us-east-1",
        isDefault: true,
      });

      // A rename forces a reconcile of the createDatabase: false project.
      const refused = yield* failureOf(
        stack.deploy(
          PrismaProject("Project", {
            name: `alchemy-lifecycle-default-${stack.stage}`,
            createDatabase: false,
          }),
        ),
      );
      expect(refused.text).toContain("cannot be removed in place");
      expect((yield* getProject({ id: bare.projectId })).data.name).toBe(bare.projectName);

      yield* stack.destroy();
      yield* expectProjectGone(bare.projectId);
    }),
  { tags: liveTags("database", "project"), timeout: 240_000 },
);

live.test.provider(
  "interrupted creates of generated projects and databases recover as owned with fresh credentials",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const resources = Effect.gen(function* () {
        const project = yield* PrismaProject("Project", {});
        const database = yield* PrismaDatabase("Database", { project });
        return { project, database };
      });

      const initial = yield* stack.deploy(resources);
      expect(initial.project.directConnectionString).toBeDefined();
      expect(initial.database.directConnectionString).toBeDefined();

      // markCreating drops the attributes, including the write-only secrets.
      yield* markCreating(stack, "Project");
      yield* markCreating(stack, "Database");
      const recovered = yield* stack.deploy(resources);
      expect(recovered.project.projectId).toBe(initial.project.projectId);
      expect(recovered.project.databaseId).toBe(initial.project.databaseId);
      expect(recovered.project.directConnectionString).toBeDefined();
      expect(recovered.database.databaseId).toBe(initial.database.databaseId);
      expect(recovered.database.directConnectionString).toBeDefined();

      yield* stack.destroy();
      yield* expectDatabaseGone(initial.database.databaseId);
      yield* expectProjectGone(initial.project.projectId);
    }),
  { tags: liveTags("database", "project"), timeout: 240_000 },
);

live.test.provider(
  "refuses a standalone default database before creating anything",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = PrismaProject("Project", { createDatabase: false });
      const created = yield* stack.deploy(project);
      const refused = yield* failureOf(
        stack.deploy(
          Effect.gen(function* () {
            const owner = yield* project;
            // `isDefault: true` is not in DatabaseProps; this pins the guard
            // for untyped callers.
            return yield* PrismaDatabase("Primary", {
              project: owner,
              isDefault: true,
            } as unknown as Prisma.DatabaseProps);
          }),
        ),
      );
      expect(refused.text).toContain("could never be destroyed");
      expect(yield* projectDatabases(created.projectId)).toEqual([]);

      yield* stack.destroy();
      yield* expectProjectGone(created.projectId);
    }),
  { tags: liveTags("database", "project"), timeout: 240_000 },
);

type AdoptedDatabaseProps = Pick<
  Prisma.DatabaseProps,
  "isDefault" | "region" | "rotateCredentialsOnAdopt"
>;

live.test.provider(
  "adopting a named database refuses default and region mismatches and rotates credentials only on request",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const resources = (props: AdoptedDatabaseProps = {}, adopted = false) =>
        Effect.gen(function* () {
          const project = yield* PrismaProject("Project", { createDatabase: false });
          const declared = PrismaDatabase("Main", { project, name: "explicit", ...props });
          const database = yield* adopted ? declared.pipe(adopt(true)) : declared;
          return { project, database };
        });

      const initial = yield* stack.deploy(resources());
      expect(initial.database.directConnectionString).toBeDefined();

      yield* forgetState(stack, "Main");
      const refused = yield* failureOf(stack.deploy(resources()));
      expect(isOwnedBySomeoneElse(refused)).toBe(true);

      yield* forgetState(stack, "Main");
      const asDefault = yield* failureOf(
        stack.deploy(resources({ isDefault: true } as unknown as AdoptedDatabaseProps, true)),
      );
      expect(asDefault.text).toContain("cannot manage a default database");
      expect((yield* getDatabase({ databaseId: initial.database.databaseId })).data.isDefault).toBe(
        false,
      );

      yield* forgetState(stack, "Main");
      const adopted = yield* stack.deploy(resources({}, true));
      expect(adopted.database.databaseId).toBe(initial.database.databaseId);
      expect(adopted.database.directConnectionString).toBeUndefined();

      yield* forgetState(stack, "Main");
      const rotated = yield* stack.deploy(resources({ rotateCredentialsOnAdopt: true }, true));
      expect(rotated.database.databaseId).toBe(initial.database.databaseId);
      expect(rotated.database.directConnectionString).toBeDefined();

      yield* forgetState(stack, "Main");
      const wrongRegion = yield* failureOf(
        stack.deploy(resources({ region: "eu-central-1" }, true)),
      );
      expect(wrongRegion.text).toContain("immutable region");
      expect(
        (yield* getDatabase({ databaseId: initial.database.databaseId })).data.region?.id,
      ).toBe("us-east-1");

      yield* stack.destroy();
      yield* expectDatabaseGone(initial.database.databaseId);
      yield* expectProjectGone(initial.project.projectId);
    }),
  { tags: liveTags("database", "project"), timeout: 240_000 },
);

live.test.provider(
  "branch promotion records the displaced default, heals demotion, and restores it on delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const resources = (withPreview: boolean) =>
        Effect.gen(function* () {
          const project = yield* PrismaProject("Project", { createDatabase: false });
          const preview = withPreview
            ? yield* PrismaBranch("Preview", { project, gitName: "preview", isDefault: true })
            : undefined;
          return { project, preview };
        });

      const initial = yield* stack.deploy(resources(true));
      const preview = initial.preview!;
      expect(preview.isDefault).toBe(true);
      expect(preview.role).toBe("preview");
      expect(preview.previousDefaultBranchId).toBeDefined();
      const mainId = preview.previousDefaultBranchId!;
      const main = (yield* getBranch({ branchId: mainId })).data;
      expect(main.isDefault).toBe(false);
      expect(main.role).toBe("production");
      expect((yield* stack.plan(resources(true))).resources.Preview?.action).toBe("noop");

      // Another client promotes main, atomically demoting the desired default.
      // The engine plans from persisted attributes, so record the demotion.
      yield* updateBranch({ branchId: mainId, isDefault: true });
      yield* patchStateAttr(stack, "Preview", { isDefault: false });
      expect((yield* stack.plan(resources(true))).resources.Preview?.action).toBe("update");
      const healed = yield* stack.deploy(resources(true));
      expect(healed.preview?.branchId).toBe(preview.branchId);
      expect(healed.preview?.isDefault).toBe(true);
      expect(healed.preview?.previousDefaultBranchId).toBe(mainId);
      expect((yield* getBranch({ branchId: preview.branchId })).data.isDefault).toBe(true);
      expect((yield* getBranch({ branchId: mainId })).data.isDefault).toBe(false);

      // Deleting the promoted branch restores the default it displaced.
      yield* stack.deploy(resources(false));
      expect((yield* getBranch({ branchId: mainId })).data.isDefault).toBe(true);
      yield* expectBranchGone(preview.branchId);

      yield* stack.destroy();
      yield* expectProjectGone(initial.project.projectId);
    }),
  { tags: liveTags("branch", "project"), timeout: 240_000 },
);

live.test.provider(
  "adopts a foreign environment variable and re-applies its write-only value on every deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = yield* stack.deploy(PrismaProject("Project", { createDatabase: false }));
      const foreign = (yield* createEnvironmentVariable({
        projectId: project.projectId,
        class: "production",
        key: "TOKEN",
        value: "foreign",
      })).data;

      const resources = (adopted: boolean) =>
        Effect.gen(function* () {
          const owner = yield* PrismaProject("Project", { createDatabase: false });
          const declared = PrismaEnvironmentVariable("Token", {
            project: owner,
            class: "production",
            key: "TOKEN",
            value: Redacted.make("desired"),
          });
          return yield* adopted ? declared.pipe(adopt(true)) : declared;
        });

      const refused = yield* failureOf(stack.deploy(resources(false)));
      expect(isOwnedBySomeoneElse(refused)).toBe(true);

      // Values are write-only, so a newer `updatedAt` is the observable proof
      // that each deploy rewrote the secret.
      const adopted = yield* stack.deploy(resources(true));
      expect(adopted.environmentVariableId).toBe(foreign.id);
      const afterAdoption = (yield* getEnvironmentVariable({ envVarId: foreign.id })).data;
      expect(Date.parse(afterAdoption.updatedAt)).toBeGreaterThan(Date.parse(foreign.updatedAt));

      const drifted = (yield* updateEnvironmentVariable({
        envVarId: foreign.id,
        value: "externally-drifted",
      })).data;
      expect((yield* stack.plan(resources(true))).resources.Token?.action).toBe("update");
      const healed = yield* stack.deploy(resources(true));
      expect(healed.environmentVariableId).toBe(foreign.id);
      const afterHeal = (yield* getEnvironmentVariable({ envVarId: foreign.id })).data;
      expect(Date.parse(afterHeal.updatedAt)).toBeGreaterThan(Date.parse(drifted.updatedAt));

      yield* stack.destroy();
      yield* expectEnvironmentVariableGone(foreign.id);
      yield* expectProjectGone(project.projectId);
    }),
  { tags: liveTags("environmentvariable", "project"), timeout: 240_000 },
);
