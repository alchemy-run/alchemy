import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "./distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

export const DESCRIPTION = "Alchemy Dev Center binding tests";

export const Center = Azure.DevCenter.DevCenter("DcBindingsCenter", {
  location: "eastus",
  projectCatalogItemSyncEnableStatus: "Enabled",
});

export const Project = Effect.gen(function* () {
  const center = yield* Center;
  return yield* Azure.DevCenter.Project("DcBindingsProject", {
    location: "eastus",
    devCenterId: center.devCenterId,
    description: DESCRIPTION,
    catalogItemSyncTypes: ["EnvironmentDefinition"],
  });
});

export const Catalog = Effect.gen(function* () {
  const project = yield* Project;
  return yield* Azure.DevCenter.ProjectCatalog("DcBindingsCatalog", {
    project: project.projectName,
    gitHub: {
      uri: "https://github.com/microsoft/devcenter-catalog.git",
      branch: "main",
      path: "/Environment-Definitions",
    },
    syncType: "Manual",
  });
});

export const EnvironmentType = Effect.gen(function* () {
  const center = yield* Center;
  return yield* Azure.DevCenter.EnvironmentType("DcBindingsDev", {
    devCenter: center.devCenterName,
    name: "dev",
  });
});

export const ProjectEnvironmentType = Effect.gen(function* () {
  const { subscriptionId } = yield* Azure.AzureEnvironment.current;
  const project = yield* Project;
  const dev = yield* EnvironmentType;
  return yield* Azure.DevCenter.ProjectEnvironmentType("DcBindingsProjectDev", {
    project: project.projectName,
    environmentType: dev.environmentTypeName,
    location: "eastus",
    deploymentTargetId: `/subscriptions/${subscriptionId}`,
    status: "Enabled",
    creatorRoles: [Azure.Authorization.BuiltInRole.Reader],
  });
});

/** Dev boxes and environments the routes ask for; none of them exist. */
export const MISSING = "alchemy-missing";

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Answers while a new identity's roles propagate to the data plane (404 "The
 * project ... cannot be found", 403, 401): re-raised so the route answers 500
 * and the caller retries.
 */
const PROPAGATING = new Set(["NotFound", "Forbidden", "Unauthorized"]);

/** The `_tag` an effect fails with (`"none"` when it succeeds). */
const failureTag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.as("none"),
    Effect.catch((error) =>
      PROPAGATING.has(error._tag) ? Effect.fail(error) : Effect.succeed(error._tag),
    ),
  );

const names = (page: { value: ReadonlyArray<{ name: string }> }) =>
  page.value.map((item) => item.name).sort();

/**
 * Effect-native Azure Function exercising every Dev Center data-plane
 * binding on a managed-identity host, one route per binding. Routes answer
 * `{ ok, result | error }` with a 500 on error, so a caller retries through
 * the cold start and role propagation, and a real failure shows the Azure
 * error. Dev boxes and environments are probed by name: none exist, so a
 * route proves the binding reaches the data plane with its role and fails
 * with the typed error.
 */
export default class DcBindingsFunction extends Azure.Functions.Function<DcBindingsFunction>()(
  "DcBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const project = yield* Project;

    const getProject = yield* Azure.DevCenter.GetProject(project);
    const getProjectAbilities = yield* Azure.DevCenter.GetProjectAbilities(project);
    const listPools = yield* Azure.DevCenter.ListPools(project);
    const getPool = yield* Azure.DevCenter.GetPool(project);
    const listSchedules = yield* Azure.DevCenter.ListSchedules(project);
    const listCatalogs = yield* Azure.DevCenter.ListCatalogs(project);
    const getCatalog = yield* Azure.DevCenter.GetCatalog(project);
    const listDefinitions = yield* Azure.DevCenter.ListEnvironmentDefinitions(project);
    const getDefinition = yield* Azure.DevCenter.GetEnvironmentDefinition(project);
    const listEnvironmentTypes = yield* Azure.DevCenter.ListEnvironmentTypes(project);
    const listDevBoxes = yield* Azure.DevCenter.ListDevBoxes(project);
    const getDevBox = yield* Azure.DevCenter.GetDevBox(project);
    const createDevBox = yield* Azure.DevCenter.CreateDevBox(project);
    const deleteDevBox = yield* Azure.DevCenter.DeleteDevBox(project);
    const startDevBox = yield* Azure.DevCenter.StartDevBox(project);
    const stopDevBox = yield* Azure.DevCenter.StopDevBox(project);
    const restartDevBox = yield* Azure.DevCenter.RestartDevBox(project);
    const getRemoteConnection = yield* Azure.DevCenter.GetRemoteConnection(project);
    const listEnvironments = yield* Azure.DevCenter.ListEnvironments(project);
    const getEnvironment = yield* Azure.DevCenter.GetEnvironment(project);
    const createEnvironment = yield* Azure.DevCenter.CreateOrReplaceEnvironment(project);
    const deleteEnvironment = yield* Azure.DevCenter.DeleteEnvironment(project);
    const getEnvironmentOutputs = yield* Azure.DevCenter.GetEnvironmentOutputs(project);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const name = url.searchParams.get("name") ?? "";
        const catalog = url.searchParams.get("catalog") ?? "";
        const devBox = { devBoxName: MISSING };
        const environment = { environmentName: MISSING };
        switch (url.pathname) {
          case "/project":
            return yield* respond(
              Effect.map(getProject(), (p) => ({ name: p.name, description: p.description })),
            );
          case "/abilities":
            return yield* respond(
              Effect.map(getProjectAbilities(), (a) => ({
                developer: [...a.abilitiesAsDeveloper].sort(),
                admin: [...a.abilitiesAsAdmin].sort(),
              })),
            );
          case "/pools":
            return yield* respond(
              Effect.gen(function* () {
                const page = yield* listPools();
                const missing = yield* failureTag(getPool({ poolName: MISSING }));
                return { names: names(page), missing };
              }),
            );
          case "/schedules":
            return yield* respond(Effect.map(listSchedules(), (page) => ({ names: names(page) })));
          case "/catalogs":
            return yield* respond(Effect.map(listCatalogs(), (page) => ({ names: names(page) })));
          case "/catalog":
            return yield* respond(
              Effect.map(getCatalog({ catalogName: catalog }), (c) => ({ name: c.name })),
            );
          case "/definitions":
            return yield* respond(
              Effect.map(listDefinitions(), (page) => ({
                ids: page.value.map((d) => `${d.catalogName}/${d.name}`).sort(),
              })),
            );
          case "/definition":
            return yield* respond(
              Effect.map(getDefinition({ catalogName: catalog, definitionName: name }), (d) => ({
                catalogName: d.catalogName,
                name: d.name,
              })),
            );
          case "/environment-types":
            return yield* respond(
              Effect.map(listEnvironmentTypes(), (page) => ({
                types: page.value.map((t) => `${t.name}:${t.status}`).sort(),
              })),
            );
          case "/devboxes":
            return yield* respond(
              Effect.gen(function* () {
                const page = yield* listDevBoxes();
                return {
                  names: names(page),
                  get: yield* failureTag(getDevBox(devBox)),
                  // An empty pool name is the typed validation error; a missing pool
                  // name answers 500.
                  create: yield* failureTag(createDevBox({ ...devBox, poolName: "" })),
                  start: yield* failureTag(startDevBox(devBox)),
                  stop: yield* failureTag(stopDevBox(devBox)),
                  restart: yield* failureTag(restartDevBox(devBox)),
                  remoteConnection: yield* failureTag(getRemoteConnection(devBox)),
                  delete: yield* failureTag(deleteDevBox(devBox)),
                };
              }),
            );
          case "/environments":
            return yield* respond(
              Effect.gen(function* () {
                const page = yield* listEnvironments();
                return {
                  names: names(page),
                  get: yield* failureTag(getEnvironment(environment)),
                  create: yield* failureTag(
                    createEnvironment({
                      ...environment,
                      environmentType: "dev",
                      catalogName: catalog,
                      environmentDefinitionName: MISSING,
                    }),
                  ),
                  outputs: (yield* getEnvironmentOutputs(environment)).outputs,
                  delete: yield* failureTag(deleteEnvironment(environment)),
                };
              }),
            );
        }
        return HttpServerResponse.text("not found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.DevCenter.GetProjectHttp,
        Azure.DevCenter.GetProjectAbilitiesHttp,
        Azure.DevCenter.ListPoolsHttp,
        Azure.DevCenter.GetPoolHttp,
        Azure.DevCenter.ListSchedulesHttp,
        Azure.DevCenter.ListCatalogsHttp,
        Azure.DevCenter.GetCatalogHttp,
        Azure.DevCenter.ListEnvironmentDefinitionsHttp,
        Azure.DevCenter.GetEnvironmentDefinitionHttp,
        Azure.DevCenter.ListEnvironmentTypesHttp,
        Azure.DevCenter.ListDevBoxesHttp,
        Azure.DevCenter.GetDevBoxHttp,
        Azure.DevCenter.CreateDevBoxHttp,
        Azure.DevCenter.DeleteDevBoxHttp,
        Azure.DevCenter.StartDevBoxHttp,
        Azure.DevCenter.StopDevBoxHttp,
        Azure.DevCenter.RestartDevBoxHttp,
        Azure.DevCenter.GetRemoteConnectionHttp,
        Azure.DevCenter.ListEnvironmentsHttp,
        Azure.DevCenter.GetEnvironmentHttp,
        Azure.DevCenter.CreateOrReplaceEnvironmentHttp,
        Azure.DevCenter.DeleteEnvironmentHttp,
        Azure.DevCenter.GetEnvironmentOutputsHttp,
      ),
    ),
  ),
) {}
