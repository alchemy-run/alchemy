import {
  deleteBranch,
  deleteConnection,
  deleteDatabase,
  deleteEnvironmentVariable,
  deleteProject,
  deleteService,
  getConnection,
  getProject,
  getProjectDatabases,
  getService,
} from "@distilled.cloud/prisma/management";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Alchemy";
import {
  expectProjectGone,
  failureOf,
  forgetState,
  markCreating,
  patchStateAttr,
} from "./fixtures/Live.ts";
import { fakeCloudProviders, makeFakeCloud } from "./fixtures/ResourcesFake.ts";
import {
  expectAppGone,
  expectBranchGone,
  expectConnectionGone,
  expectDatabaseGone,
  expectEnvironmentVariableGone,
  observeBranch,
  observeDatabase,
  observeEnvironmentVariable,
} from "./fixtures/ResourcesLive.ts";

const { test } = Test.make({ providers: Prisma.providers() });

const tags = ["provider:prisma", "provider:prisma:project", "live"];

const RENAMED = "alchemy-test-prisma-project-renamed";

const projectStack = (props: Prisma.ProjectProps = {}) =>
  Prisma.Project("Project", { createDatabase: false, ...props });

const observeProject = (id: string) =>
  getProject({ id }).pipe(Effect.map((response) => response.data));

test.provider(
  "creates a project, renames it in place, and writes then clears managed settings",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(projectStack());
    expect(initial.databaseId).toBeUndefined();
    expect(initial.defaultRegion).toBeNull();
    expect((yield* observeProject(initial.projectId)).name).toBe(initial.projectName);

    const renamePlan = yield* stack.plan(projectStack({ name: RENAMED }));
    expect(renamePlan.resources["Project"]).toMatchObject({ action: "update" });
    const renamed = yield* stack.deploy(projectStack({ name: RENAMED }));
    expect(renamed.projectId).toBe(initial.projectId);
    expect((yield* observeProject(initial.projectId)).name).toBe(RENAMED);

    const managed = yield* stack.deploy(
      projectStack({ name: RENAMED, settings: { alchemyTest: true, tier: "dev" } }),
    );
    expect(managed.projectId).toBe(initial.projectId);
    // Settings are write-only, so explicit settings are re-applied every deploy.
    const reapply = yield* stack.plan(
      projectStack({ name: RENAMED, settings: { tier: "dev", alchemyTest: true } }),
    );
    expect(reapply.resources["Project"]).toMatchObject({ action: "update" });

    // Removing the prop clears the previously managed settings once.
    const clearPlan = yield* stack.plan(projectStack({ name: RENAMED }));
    expect(clearPlan.resources["Project"]).toMatchObject({ action: "update" });
    const cleared = yield* stack.deploy(projectStack({ name: RENAMED }));
    expect(cleared.projectId).toBe(initial.projectId);
    const settled = yield* stack.plan(projectStack({ name: RENAMED }));
    expect(settled.resources["Project"]).toMatchObject({ action: "noop" });

    yield* stack.destroy();
    yield* expectProjectGone(initial.projectId);
  }),
  { tags, timeout: 180_000 },
);

test.provider(
  "adds a default database to an existing project in place and refuses unsafe default changes",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(projectStack());
    expect(initial.databaseId).toBeUndefined();

    const ensurePlan = yield* stack.plan(projectStack({ createDatabase: true }));
    expect(ensurePlan.resources["Project"]).toMatchObject({ action: "update" });
    const ensured = yield* stack.deploy(projectStack({ createDatabase: true }));
    expect(ensured.projectId).toBe(initial.projectId);
    expect(ensured.databaseId).toBeDefined();
    expect(ensured.defaultRegion).toBe("us-east-1");
    const direct = Redacted.value(ensured.directConnectionString!);
    expect(direct).toMatch(/^postgres/);
    expect(JSON.stringify(ensured)).not.toContain(direct);
    const databases = (yield* getProjectDatabases({ projectId: initial.projectId })).data;
    expect(
      databases.filter((database) => database.isDefault).map((database) => database.id),
    ).toEqual([ensured.databaseId]);

    const repeated = yield* stack.deploy(projectStack({ createDatabase: true }));
    expect(repeated.databaseId).toBe(ensured.databaseId);

    // The API cannot remove the last default database, nor move it in place.
    const dropPlan = yield* stack.plan(projectStack({ createDatabase: false }));
    expect(dropPlan.resources["Project"]).toMatchObject({ action: "replace" });
    const move = yield* failureOf(
      stack.plan(projectStack({ createDatabase: true, region: "eu-west-3" })),
    );
    expect(move.text).toContain("Cannot safely change Prisma project");

    const rotatePlan = yield* stack.plan(
      projectStack({ createDatabase: true, rotateCredentialsOnAdopt: true }),
    );
    expect(rotatePlan.resources["Project"]).toMatchObject({ action: "update" });

    yield* stack.destroy();
    yield* expectProjectGone(initial.projectId);
  }),
  { tags: [...tags, "provider:prisma:database"], timeout: 240_000 },
);

test.provider(
  "requires adoption for a named project after lost state and recovers an interrupted generated create",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const named = yield* stack.deploy(projectStack({ name: "alchemy-test-prisma-project-adopt" }));
    yield* forgetState(stack, "Project");
    const refused = yield* failureOf(
      stack.deploy(projectStack({ name: "alchemy-test-prisma-project-adopt" })),
    );
    expect(refused.errors.some((error) => error instanceof OwnedBySomeoneElse)).toBe(true);
    const adopted = yield* stack.deploy(
      projectStack({ name: "alchemy-test-prisma-project-adopt" }).pipe(adopt(true)),
    );
    expect(adopted.projectId).toBe(named.projectId);
    yield* stack.destroy();
    yield* expectProjectGone(named.projectId);

    // A generated name embeds this instance's ID, so an interrupted create
    // finds it again and recovers it as owned.
    const generated = yield* stack.deploy(projectStack());
    yield* markCreating(stack, "Project");
    const recovered = yield* stack.deploy(projectStack());
    expect(recovered.projectId).toBe(generated.projectId);

    yield* stack.destroy();
    yield* expectProjectGone(generated.projectId);
  }),
  { tags, timeout: 180_000 },
);

test.provider(
  "does not delete a cloud project when state holds a dev placeholder ID",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(projectStack());
    yield* patchStateAttr(stack, "Project", { projectId: "dev:project:Project" });

    yield* stack.destroy();
    expect((yield* observeProject(initial.projectId)).id).toBe(initial.projectId);

    // The test created this project; remove it now that state is gone.
    yield* deleteProject({ id: initial.projectId });
    yield* expectProjectGone(initial.projectId);
  }),
  { tags, timeout: 120_000 },
);

const graph = (
  options: {
    connectionName?: string;
    rotate?: boolean;
    databaseName?: string;
    region?: "us-east-1" | "eu-west-3";
    displayName?: string;
    envClass?: "production" | "preview";
    envKey?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const project = yield* Prisma.Project("Project", { createDatabase: false });
    const database = yield* Prisma.Database("Database", {
      project,
      ...(options.databaseName === undefined ? {} : { name: options.databaseName }),
      ...(options.region === undefined ? {} : { region: options.region }),
    });
    const connection = yield* Prisma.Connection("Connection", {
      database,
      ...(options.connectionName === undefined ? {} : { name: options.connectionName }),
      ...(options.rotate === undefined ? {} : { rotate: options.rotate }),
    });
    const branch = yield* Prisma.Branch("Preview", { project, gitName: "feature/graph" });
    const app = yield* Prisma.App("Web", {
      project,
      ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
    });
    const variable = yield* Prisma.EnvironmentVariable("Token", {
      project,
      class: options.envClass ?? "production",
      key: options.envKey ?? "TOKEN",
      value: Redacted.make("graph-secret"),
    });
    return { project, database, connection, branch, app, variable };
  });

test.provider(
  "deploys a project graph through the management APIs and destroys every resource",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const out = yield* stack.deploy(graph());
    const projectId = out.project.projectId;
    expect(out.database.projectId).toBe(projectId);
    expect(out.connection.databaseId).toBe(out.database.databaseId);
    expect(out.branch.projectId).toBe(projectId);
    expect(out.app.projectId).toBe(projectId);
    expect(out.variable.projectId).toBe(projectId);

    // Secrets come back redacted and never serialize in plain text.
    const databaseSecret = Redacted.value(out.database.directConnectionString!);
    const connectionSecret = Redacted.value(out.connection.directConnectionString!);
    expect(JSON.stringify(out)).not.toContain(databaseSecret);
    expect(JSON.stringify(out)).not.toContain(connectionSecret);
    expect(Redacted.value(out.variable.value)).toBe("graph-secret");
    expect(JSON.stringify(out.variable)).not.toContain("graph-secret");

    expect((yield* observeDatabase(out.database.databaseId)).project.id).toBe(projectId);
    expect((yield* getConnection({ id: out.connection.connectionId })).data.database.id).toBe(
      out.database.databaseId,
    );
    expect((yield* observeBranch(out.branch.branchId)).gitName).toBe("feature/graph");
    expect((yield* getService({ serviceId: out.app.appId })).data.projectId).toBe(projectId);
    const variable = yield* observeEnvironmentVariable(out.variable.environmentVariableId);
    expect(variable.key).toBe("TOKEN");
    expect(variable.isManagedBySystem).toBe(false);

    // Update vs. replace classification for each resource in the graph.
    const planOf = (options: Parameters<typeof graph>[0]) =>
      stack.plan(graph(options)).pipe(Effect.map((plan) => plan.resources));
    expect((yield* planOf({ databaseName: "renamed" }))["Database"]).toMatchObject({
      action: "update",
    });
    expect((yield* planOf({ region: "eu-west-3" }))["Database"]).toMatchObject({
      action: "replace",
    });
    expect((yield* planOf({ rotate: true }))["Connection"]).toMatchObject({ action: "update" });
    expect((yield* planOf({ connectionName: "worker" }))["Connection"]).toMatchObject({
      action: "replace",
    });
    expect((yield* planOf({ displayName: "renamed-web" }))["Web"]).toMatchObject({
      action: "update",
    });
    // Environment values are write-only, so every deploy re-applies them.
    expect((yield* planOf({}))["Token"]).toMatchObject({ action: "update" });
    expect((yield* planOf({ envClass: "preview" }))["Token"]).toMatchObject({
      action: "replace",
    });
    expect((yield* planOf({ envKey: "OTHER_TOKEN" }))["Token"]).toMatchObject({
      action: "replace",
    });

    yield* stack.destroy();
    yield* expectEnvironmentVariableGone(out.variable.environmentVariableId);
    yield* expectAppGone(out.app.appId);
    yield* expectBranchGone(out.branch.branchId);
    yield* expectConnectionGone(out.connection.connectionId);
    yield* expectDatabaseGone(out.database.databaseId);
    yield* expectProjectGone(projectId);
  }),
  {
    tags: [
      ...tags,
      "provider:prisma:app",
      "provider:prisma:branch",
      "provider:prisma:connection",
      "provider:prisma:database",
      "provider:prisma:environmentvariable",
    ],
    timeout: 240_000,
  },
);

test.provider(
  "treats resources deleted out of band as already gone on destroy",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const out = yield* stack.deploy(graph());
    yield* deleteEnvironmentVariable({ envVarId: out.variable.environmentVariableId });
    yield* deleteConnection({ id: out.connection.connectionId });
    yield* deleteBranch({ branchId: out.branch.branchId });
    yield* deleteDatabase({ databaseId: out.database.databaseId });
    yield* deleteService({ serviceId: out.app.appId });
    yield* deleteProject({ id: out.project.projectId });
    yield* expectProjectGone(out.project.projectId);

    yield* stack.destroy();
    yield* expectDatabaseGone(out.database.databaseId);
    yield* expectProjectGone(out.project.projectId);
  }),
  {
    tags: [
      ...tags,
      "provider:prisma:app",
      "provider:prisma:branch",
      "provider:prisma:connection",
      "provider:prisma:database",
      "provider:prisma:environmentvariable",
    ],
    timeout: 240_000,
  },
);

// Fault injection the real API cannot produce on demand: a create whose
// response is lost as a 409, and a create response that contradicts the
// request.
const fakeTags = ["unit", "provider:prisma", "provider:prisma:project", "local"];

const contradictionCloud = makeFakeCloud();
const contradiction = Test.make({ providers: fakeCloudProviders(contradictionCloud) });

contradiction.test.provider(
  "rejects a createDatabase false response that contains a default database",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    contradictionCloud.faults.projectCreateReturnsDatabase = true;
    const failure = yield* failureOf(stack.deploy(projectStack({ name: "app" })));
    contradictionCloud.faults.projectCreateReturnsDatabase = false;
    expect(failure.text).toContain("created unexpected default database");
    const posted = contradictionCloud.api.captured.filter(
      (request) => request.method === "POST" && request.pathname === "/v1/projects",
    );
    expect(posted.map((request) => request.bodyJson)).toEqual([
      { name: "app", createDatabase: false },
    ]);

    yield* stack.destroy();
  }),
  { tags: fakeTags },
);

const recoveryCloud = makeFakeCloud();
const recovery = Test.make({ providers: fakeCloudProviders(recoveryCloud) });

recovery.test.provider(
  "recovers a generated project and its default credentials after a create conflict",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    recoveryCloud.faults.race.add("project");
    const recovered = yield* stack.deploy(Prisma.Project("Project", {}));
    expect(recoveryCloud.projects.size).toBe(1);
    expect(recoveryCloud.projects.get(recovered.projectId)?.name).toBe(recovered.projectName);
    expect(Redacted.value(recovered.directConnectionString!)).toContain(recovered.databaseId);
    expect(recoveryCloud.api.captured.some((request) => request.pathname.endsWith("/rotate"))).toBe(
      true,
    );

    yield* stack.destroy();
    expect(recoveryCloud.projects.size).toBe(0);
  }),
  { tags: [...fakeTags, "provider:prisma:database"] },
);

const raceCloud = makeFakeCloud();
const race = Test.make({ providers: fakeCloudProviders(raceCloud) });

race.test.provider(
  "refuses to take over a named project that appears after the adoption check",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    raceCloud.faults.race.add("project");
    const failure = yield* failureOf(stack.deploy(projectStack({ name: "app" })));
    expect(failure.text).toContain("appeared after the adoption check");
    expect(Array.from(raceCloud.projects.values()).map((project) => project.name)).toEqual(["app"]);

    yield* stack.destroy();
  }),
  { tags: fakeTags },
);
