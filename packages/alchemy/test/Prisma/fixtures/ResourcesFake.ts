import * as Layer from "effect/Layer";
import { AlchemyContext } from "@/AlchemyContext";
import { Branch as PrismaBranch, BranchProvider } from "@/Prisma/Branch";
import { PrismaClient, type PrismaManagementClient } from "@/Prisma/Client";
import { CustomDomain as PrismaCustomDomain, CustomDomainProvider } from "@/Prisma/CustomDomain";
import { Database as PrismaDatabase, DatabaseProvider } from "@/Prisma/Database";
import {
  EnvironmentVariable as PrismaEnvironmentVariable,
  EnvironmentVariableProvider,
} from "@/Prisma/EnvironmentVariable";
import { Project as PrismaProject, ProjectProvider } from "@/Prisma/Project";
import {
  SourceRepository as PrismaSourceRepository,
  SourceRepositoryProvider,
} from "@/Prisma/SourceRepository";
import * as Provider from "@/Provider";
import {
  type Captured,
  conflict,
  data,
  FAKE_API_BASE_URL,
  makeFakeManagementApi,
  noContent,
  notFound,
  page,
  unhandled,
  wireConnection,
  wireProject,
} from "./FakeManagementApi.ts";

/**
 * An in-memory Prisma Management API for the fake-backed `test.provider`
 * cases in the Project, Branch, Database, EnvironmentVariable, and
 * SourceRepository suites. It is served over the wire (see
 * `FakeManagementApi.ts`), so the providers run their real distilled calls;
 * `faults` injects what the live API cannot produce on demand: create races
 * (the POST lands but answers 409), a create response that contradicts the
 * request, and database source shapes.
 */

const REF = `${FAKE_API_BASE_URL}/v1`;
const createdAt = "2026-01-01T00:00:00.000Z";

export type RaceKind =
  | "project"
  | "database"
  | "branch"
  | "environmentVariable"
  | "sourceRepository";

export interface FakeFaults {
  /** The next POST of each kind creates the entity but answers 409. */
  readonly race: Set<RaceKind>;
  /** POST /v1/projects returns a default database even for createDatabase: false. */
  projectCreateReturnsDatabase: boolean;
  /** Rewrites the source the API reports for a created database. */
  databaseSource: ((requested: unknown) => unknown) | undefined;
}

interface FakeProject {
  id: string;
  name: string;
}

interface FakeDatabase {
  id: string;
  name: string;
  projectId: string;
  branchId: string | null;
  isDefault: boolean;
  logicalId: string | null;
  source: unknown;
  region: string;
}

interface FakeBranch {
  id: string;
  gitName: string;
  projectId: string;
  isDefault: boolean;
  role: "production" | "preview";
}

interface FakeVariable {
  id: string;
  projectId: string;
  branchId: string | null;
  class: "production" | "preview";
  key: string;
  valueKid: string;
  isManagedBySystem: boolean;
}

interface FakeRepository {
  id: string;
  projectId: string;
  repoId: number;
  provider: string;
  installationId: string;
  status: "active" | "archived";
}

export const makeFakeCloud = () => {
  const projects = new Map<string, FakeProject>();
  const databases = new Map<string, FakeDatabase>();
  const branches = new Map<string, FakeBranch>();
  const variables = new Map<string, FakeVariable>();
  const repositories = new Map<string, FakeRepository>();
  const faults: FakeFaults = {
    race: new Set(),
    projectCreateReturnsDatabase: false,
    databaseSource: undefined,
  };
  let nextId = 1;
  const id = (prefix: string) => `${prefix}-${nextId++}`;

  const wireBranch = (branch: FakeBranch) => ({
    id: branch.id,
    type: "branch",
    url: `${REF}/branches/${branch.id}`,
    gitName: branch.gitName,
    isDefault: branch.isDefault,
    role: branch.role,
    createdAt,
    updatedAt: createdAt,
    project: { id: branch.projectId, url: `${REF}/projects/${branch.projectId}`, name: "app" },
  });

  // Like the real API, only create and rotate responses carry secrets.
  const connectionOf = (database: FakeDatabase, withSecrets = false) =>
    wireConnection({
      id: `connection-${database.id}`,
      databaseId: database.id,
      databaseName: database.name,
      ...(withSecrets
        ? {
            directConnectionString: `postgres://user:password@db.prisma.test/${database.id}`,
            pooledConnectionString: `postgres://user:password@pool.prisma.test/${database.id}`,
          }
        : {}),
    });

  const wireDb = (database: FakeDatabase) => ({
    id: database.id,
    type: "database",
    url: `${REF}/databases/${database.id}`,
    name: database.name,
    status: "ready",
    createdAt,
    isDefault: database.isDefault,
    defaultConnectionId: `connection-${database.id}`,
    connections: [connectionOf(database)],
    project: { id: database.projectId, url: `${REF}/projects/${database.projectId}`, name: "app" },
    region: { id: database.region, name: database.region },
    source: database.source,
    branchId: database.branchId,
    logicalId: database.logicalId,
  });

  const wireCreatedDb = (database: FakeDatabase) => ({
    ...wireDb(database),
    connections: [connectionOf(database, true)],
    apiKeys: [],
    connectionString: "postgres://direct",
    directConnection: { host: "db.prisma.test", user: "prisma", pass: "secret" },
  });

  const wireVariable = (variable: FakeVariable) => ({
    id: variable.id,
    type: "environment-variable",
    url: `${REF}/environment-variables/${variable.id}`,
    projectId: variable.projectId,
    branchId: variable.branchId,
    class: variable.class,
    key: variable.key,
    valueKid: variable.valueKid,
    isManagedBySystem: variable.isManagedBySystem,
    createdAt,
    updatedAt: createdAt,
  });

  const wireRepository = (repository: FakeRepository) => ({
    id: repository.id,
    type: "source-repository",
    url: `${REF}/source-repositories/${repository.id}`,
    repoId: repository.repoId,
    provider: repository.provider,
    repoFullName: `acme/repo-${repository.repoId}`,
    defaultBranch: "main",
    isPrivate: true,
    status: repository.status,
    projectId: repository.projectId,
    installationId: repository.installationId,
    createdAt,
    updatedAt: createdAt,
  });

  const defaultBranchOf = (projectId: string) =>
    Array.from(branches.values()).find(
      (branch) => branch.projectId === projectId && branch.isDefault,
    );

  const addBranch = (projectId: string, gitName: string, isDefault: boolean) => {
    const first = defaultBranchOf(projectId) === undefined;
    if (isDefault && !first) {
      for (const branch of branches.values()) {
        if (branch.projectId === projectId) branch.isDefault = false;
      }
    }
    const branch: FakeBranch = {
      id: id("branch"),
      gitName,
      projectId,
      isDefault: first || isDefault,
      role: first ? "production" : "preview",
    };
    branches.set(branch.id, branch);
    return branch;
  };

  const addDatabase = (input: {
    projectId: string;
    name?: string;
    region?: string;
    isDefault?: boolean;
    branchId?: string | null;
    branchGitName?: string | null;
    logicalId?: string | null;
    source?: unknown;
  }) => {
    if (input.isDefault) {
      for (const database of databases.values()) {
        if (database.projectId === input.projectId) database.isDefault = false;
      }
    }
    const branchId =
      input.branchId ??
      (input.branchGitName
        ? (Array.from(branches.values()).find(
            (branch) =>
              branch.projectId === input.projectId && branch.gitName === input.branchGitName,
          )?.id ?? addBranch(input.projectId, input.branchGitName, false).id)
        : (defaultBranchOf(input.projectId)?.id ?? null));
    const database: FakeDatabase = {
      id: id("database"),
      name: input.name ?? "default",
      projectId: input.projectId,
      branchId,
      isDefault: input.isDefault ?? false,
      logicalId: input.logicalId ?? null,
      source: faults.databaseSource
        ? faults.databaseSource(input.source)
        : (input.source ?? { type: "empty" }),
      region: input.region ?? "us-east-1",
    };
    databases.set(database.id, database);
    return database;
  };

  const raced = (kind: RaceKind) => {
    if (!faults.race.has(kind)) return false;
    faults.race.delete(kind);
    return true;
  };

  const handle = (request: Captured): Response => {
    const [head, entityId, tail] = request.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .slice(1);
    const query = new URLSearchParams(request.search);
    const body = (request.bodyJson ?? {}) as Record<string, any>;
    const { method } = request;

    if (head === "projects") {
      if (entityId === undefined) {
        if (method === "GET") {
          return page(
            Array.from(projects.values()).map((p) => wireProject({ id: p.id, name: p.name })),
          );
        }
        const project: FakeProject = { id: id("project"), name: body.name };
        projects.set(project.id, project);
        addBranch(project.id, "main", true);
        const database =
          body.createDatabase !== false || faults.projectCreateReturnsDatabase
            ? addDatabase({ projectId: project.id, region: body.region, isDefault: true })
            : undefined;
        if (raced("project")) return conflict();
        return data(
          {
            ...wireProject({ id: project.id, name: project.name }),
            database: database ? wireCreatedDb(database) : null,
          },
          { status: 201 },
        );
      }
      const project = projects.get(entityId);
      if (!project) return notFound();
      if (tail === "databases") {
        if (method === "GET") {
          return page(
            Array.from(databases.values())
              .filter((database) => database.projectId === project.id)
              .map(wireDb),
          );
        }
        const database = addDatabase({
          projectId: project.id,
          region: body.region,
          isDefault: body.isDefault,
        });
        return data(wireCreatedDb(database), { status: 201 });
      }
      if (tail === "branches") {
        if (method === "GET") {
          const gitName = query.get("gitName");
          return page(
            Array.from(branches.values())
              .filter(
                (branch) =>
                  branch.projectId === project.id &&
                  (gitName === null || branch.gitName === gitName),
              )
              .map(wireBranch),
          );
        }
        const branch = addBranch(project.id, body.gitName, body.isDefault === true);
        if (raced("branch")) return conflict();
        return data(wireBranch(branch), { status: 201 });
      }
      if (method === "GET") return data(wireProject({ id: project.id, name: project.name }));
      if (method === "PATCH") {
        if (typeof body.name === "string") project.name = body.name;
        return data(wireProject({ id: project.id, name: project.name }));
      }
      if (method === "DELETE") {
        projects.delete(project.id);
        const owned = (entity: { readonly projectId: string }) => entity.projectId === project.id;
        for (const [key, entity] of databases) if (owned(entity)) databases.delete(key);
        for (const [key, entity] of branches) if (owned(entity)) branches.delete(key);
        for (const [key, entity] of variables) if (owned(entity)) variables.delete(key);
        for (const [key, entity] of repositories) if (owned(entity)) repositories.delete(key);
        return noContent();
      }
    }

    if (head === "services" && entityId === undefined && method === "GET") {
      return page([]);
    }

    if (head === "databases") {
      if (entityId === undefined) {
        if (method === "GET") {
          const projectId = query.get("projectId");
          const logicalId = query.get("logicalId");
          const branchId = query.get("branchId");
          return page(
            Array.from(databases.values())
              .filter(
                (database) =>
                  (projectId === null || database.projectId === projectId) &&
                  (logicalId === null || database.logicalId === logicalId) &&
                  (branchId === null || database.branchId === branchId),
              )
              .map(wireDb),
          );
        }
        const database = addDatabase(body as Parameters<typeof addDatabase>[0]);
        if (raced("database")) {
          // The landed create is not yet visible to the logical-ID filter.
          database.logicalId = null;
          return conflict();
        }
        return data(wireCreatedDb(database), { status: 201 });
      }
      const database = databases.get(entityId);
      if (!database) return notFound();
      if (tail === "connections") return page([connectionOf(database)]);
      if (method === "GET") return data(wireDb(database));
      if (method === "PATCH") {
        if (typeof body.name === "string") database.name = body.name;
        if (body.branchId !== undefined) database.branchId = body.branchId;
        if ("logicalId" in body) database.logicalId = body.logicalId;
        return data(wireDb(database));
      }
      if (method === "DELETE") {
        databases.delete(database.id);
        return noContent();
      }
    }

    if (head === "connections" && entityId !== undefined && tail === "rotate") {
      const database = databases.get(entityId.replace(/^connection-/, ""));
      return database ? data(connectionOf(database, true)) : notFound();
    }

    if (head === "branches" && entityId !== undefined) {
      const branch = branches.get(entityId);
      if (!branch) return notFound();
      if (method === "GET") return data(wireBranch(branch));
      if (method === "PATCH") {
        if (body.isDefault === true) {
          for (const other of branches.values()) {
            if (other.projectId === branch.projectId) other.isDefault = other.id === branch.id;
          }
        }
        return data(wireBranch(branch));
      }
      if (method === "DELETE") {
        branches.delete(branch.id);
        return noContent();
      }
    }

    if (head === "environment-variables") {
      if (entityId === undefined) {
        if (method === "GET") {
          return page(
            Array.from(variables.values())
              .filter(
                (variable) =>
                  (query.get("projectId") === null ||
                    variable.projectId === query.get("projectId")) &&
                  (query.get("class") === null || variable.class === query.get("class")) &&
                  (query.get("key") === null || variable.key === query.get("key")),
              )
              .map(wireVariable),
          );
        }
        const variable: FakeVariable = {
          id: id("env"),
          projectId: body.projectId,
          branchId: body.branchId ?? null,
          class: body.class,
          key: body.key,
          valueKid: id("kid"),
          isManagedBySystem: false,
        };
        variables.set(variable.id, variable);
        if (raced("environmentVariable")) return conflict();
        return data(wireVariable(variable), { status: 201 });
      }
      const variable = variables.get(entityId);
      if (!variable) return notFound();
      if (method === "GET") return data(wireVariable(variable));
      if (method === "PATCH") {
        variable.valueKid = id("kid");
        return data(wireVariable(variable));
      }
      if (method === "DELETE") {
        variables.delete(variable.id);
        return noContent();
      }
    }

    if (head === "source-repositories") {
      if (entityId === undefined) {
        if (method === "GET") {
          return page(
            Array.from(repositories.values())
              .filter((repository) => repository.projectId === query.get("projectId"))
              .map(wireRepository),
          );
        }
        const repository: FakeRepository = {
          id: id("repository"),
          projectId: body.projectId,
          repoId: body.providerRepositoryId,
          provider: body.provider,
          installationId: body.installationId ?? "installation-auto",
          status: "active",
        };
        repositories.set(repository.id, repository);
        if (raced("sourceRepository")) return conflict();
        return data(wireRepository(repository), { status: 201 });
      }
      const repository = repositories.get(entityId);
      if (!repository || repository.status !== "active") return notFound();
      if (method === "GET") return data(wireRepository(repository));
      if (method === "DELETE") {
        repository.status = "archived";
        return noContent();
      }
    }

    return unhandled(request);
  };

  const api = makeFakeManagementApi(handle);
  return { api, faults, projects, databases, branches, variables, repositories, addBranch };
};

export type FakeCloud = ReturnType<typeof makeFakeCloud>;

const liveProviderContext = Layer.succeed(AlchemyContext, {
  dotAlchemy: ".alchemy-test",
  dev: false,
  adopt: false,
});

class FakePrismaProviders extends Provider.ProviderCollection<FakePrismaProviders>()("Prisma") {}

/** Every distilled-backed provider these suites exercise, over one fake cloud. */
export const fakeCloudProviders = (cloud: FakeCloud) =>
  Layer.effect(
    FakePrismaProviders,
    Provider.collection([
      PrismaProject,
      PrismaBranch,
      PrismaDatabase,
      PrismaEnvironmentVariable,
      PrismaSourceRepository,
    ]),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ProjectProvider(),
        BranchProvider(),
        DatabaseProvider(),
        EnvironmentVariableProvider(),
        SourceRepositoryProvider(),
      ),
    ),
    Layer.provide(liveProviderContext),
    Layer.provideMerge(cloud.api.layer),
  );

/** CustomDomain still speaks the client seam, so its fake is client-shaped. */
export const fakeCustomDomainProviders = (client: PrismaManagementClient) =>
  Layer.effect(FakePrismaProviders, Provider.collection([PrismaCustomDomain])).pipe(
    Layer.provideMerge(CustomDomainProvider()),
    Layer.provideMerge(Layer.succeed(PrismaClient, client)),
    Layer.provide(liveProviderContext),
  );
