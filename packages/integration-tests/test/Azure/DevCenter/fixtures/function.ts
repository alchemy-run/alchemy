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
  // Lets the gated dev box lifecycle's pool use a Microsoft-hosted network.
  microsoftHostedNetworkEnableStatus: "Enabled",
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

/** A dev center catalog of customization tasks (`winget`, `choco`, `powershell`, ...). */
export const TaskCatalog = Effect.gen(function* () {
  const center = yield* Center;
  return yield* Azure.DevCenter.Catalog("DcBindingsTasks", {
    devCenter: center.devCenterName,
    gitHub: {
      uri: "https://github.com/microsoft/devcenter-catalog.git",
      branch: "main",
      path: "/Tasks",
    },
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

/** The dev box the gated lifecycle creates (`/live` routes). */
export const LIVE_DEV_BOX = "alchemy-live";

/** An operation, snapshot, or log id that does not exist. */
const ZERO_ID = "00000000-0000-0000-0000-000000000000";

/** A customization task the project's catalogs do not publish. */
const TASK = `catalog/${MISSING}`;

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

/** The operation id at the end of an `operationLocation` (`…/operationstatuses/<id>?api-version=…`). */
const operationIdOf = (location: string | undefined) =>
  location === undefined ? "" : (new URL(location).pathname.split("/").pop() ?? "");

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
    const listDevBoxActions = yield* Azure.DevCenter.ListDevBoxActions(project);
    const getDevBoxAction = yield* Azure.DevCenter.GetDevBoxAction(project);
    const skipDevBoxAction = yield* Azure.DevCenter.SkipDevBoxAction(project);
    const delayDevBoxAction = yield* Azure.DevCenter.DelayDevBoxAction(project);
    const delayDevBoxActions = yield* Azure.DevCenter.DelayDevBoxActions(project);
    const listDevBoxSnapshots = yield* Azure.DevCenter.ListDevBoxSnapshots(project);
    const getDevBoxSnapshot = yield* Azure.DevCenter.GetDevBoxSnapshot(project);
    const captureDevBoxSnapshot = yield* Azure.DevCenter.CaptureDevBoxSnapshot(project);
    const restoreDevBoxSnapshot = yield* Azure.DevCenter.RestoreDevBoxSnapshot(project);
    const repairDevBox = yield* Azure.DevCenter.RepairDevBox(project);
    const listCustomizationGroups = yield* Azure.DevCenter.ListCustomizationGroups(project);
    const getCustomizationGroup = yield* Azure.DevCenter.GetCustomizationGroup(project);
    const createCustomizationGroup = yield* Azure.DevCenter.CreateCustomizationGroup(project);
    const getCustomizationTaskLog = yield* Azure.DevCenter.GetCustomizationTaskLog(project);
    const listDevBoxOperations = yield* Azure.DevCenter.ListDevBoxOperations(project);
    const getDevBoxOperation = yield* Azure.DevCenter.GetDevBoxOperation(project);
    const listTaskDefinitions = yield* Azure.DevCenter.ListCustomizationTaskDefinitions(project);
    const getTaskDefinition = yield* Azure.DevCenter.GetCustomizationTaskDefinition(project);
    const validateTasks = yield* Azure.DevCenter.ValidateCustomizationTasks(project);
    const getImagingTaskLog = yield* Azure.DevCenter.GetImagingTaskLog(project);
    const getOperationStatus = yield* Azure.DevCenter.GetOperationStatus(project);
    const listSchedulesByPool = yield* Azure.DevCenter.ListSchedulesByPool(project);
    const getScheduleByPool = yield* Azure.DevCenter.GetScheduleByPool(project);
    const listDefinitionsByCatalog =
      yield* Azure.DevCenter.ListEnvironmentDefinitionsByCatalog(project);

    const live = { devBoxName: LIVE_DEV_BOX };
    const liveStep = (params: URLSearchParams) =>
      Effect.gen(function* () {
        const until = yield* Effect.sync(() =>
          new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        );
        switch (params.get("step")) {
          case "create": {
            const box = yield* createDevBox({ ...live, poolName: params.get("pool") ?? "" });
            return { name: box.name };
          }
          case "get":
            return yield* getDevBox(live).pipe(
              Effect.map((box) => ({
                provisioningState: box.provisioningState,
                powerState: box.powerState,
              })),
              Effect.catchTag("DevBoxNotFound", () => Effect.succeed({ gone: true })),
            );
          case "actions": {
            const page = yield* listDevBoxActions(live);
            const first = page.value[0];
            if (first === undefined) return { actions: [] };
            const action = { ...live, actionName: first.name };
            const read = yield* getDevBoxAction(action);
            const delayed = yield* delayDevBoxAction({ ...action, until });
            const all = yield* delayDevBoxActions({ ...live, until });
            yield* skipDevBoxAction(action);
            return {
              actions: page.value.map((a) => a.name),
              read: read.name,
              suspendedUntil: delayed.suspendedUntil,
              delayed: all.value.map((r) => `${r.name}:${r.result}`),
            };
          }
          case "operations": {
            const page = yield* listDevBoxOperations(live);
            const first = page.value[0];
            const read =
              first === undefined
                ? undefined
                : yield* getDevBoxOperation({ ...live, operationId: first.operationId });
            return {
              operations: page.value.map((o) => `${o.kind}:${o.operationId}`),
              read: read && `${read.kind}:${read.operationId}`,
            };
          }
          case "customize": {
            const group = yield* createCustomizationGroup({
              ...live,
              customizationGroupName: "alchemy",
              tasks: [
                {
                  name: `${params.get("catalog")}/powershell`,
                  parameters: { command: "Write-Output alchemy" },
                },
              ],
            });
            return { name: group.name };
          }
          case "group": {
            const group = yield* getCustomizationGroup({
              ...live,
              customizationGroupName: "alchemy",
            });
            const page = yield* listCustomizationGroups({ ...live, include: "tasks" });
            const task = group.tasks?.[0];
            const log =
              task?.id === undefined || group.status === "Running" || group.status === "NotStarted"
                ? undefined
                : yield* getCustomizationTaskLog({
                    ...live,
                    customizationGroupName: "alchemy",
                    customizationTaskId: task.id,
                  });
            return {
              status: group.status,
              groups: page.value.map((g) => g.name),
              log: log === undefined ? undefined : log.length > 0,
            };
          }
          case "capture": {
            const capture = yield* captureDevBoxSnapshot(live);
            return { operationId: operationIdOf(capture.operationLocation) };
          }
          case "status": {
            const status = yield* getOperationStatus({ operationId: params.get("id") ?? "" });
            return { status: status.status };
          }
          case "snapshots": {
            const page = yield* listDevBoxSnapshots(live);
            const first = page.value[0];
            const read =
              first === undefined
                ? undefined
                : yield* getDevBoxSnapshot({ ...live, snapshotId: first.snapshotId });
            return { snapshots: page.value.map((s) => s.snapshotId), read: read?.snapshotId };
          }
          case "restore": {
            const restore = yield* restoreDevBoxSnapshot({
              ...live,
              snapshotId: params.get("id") ?? "",
            });
            return { operationId: operationIdOf(restore.operationLocation) };
          }
          case "repair": {
            const repair = yield* repairDevBox(live);
            return { operationId: operationIdOf(repair.operationLocation) };
          }
          case "delete":
            yield* deleteDevBox(live);
            return { deleted: true };
        }
        return { unknownStep: params.get("step") };
      });

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
          case "/devbox-extras":
            return yield* respond(
              Effect.gen(function* () {
                const until = yield* Effect.sync(() =>
                  new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                );
                const action = { ...devBox, actionName: "schedule-default" };
                const group = { ...devBox, customizationGroupName: MISSING };
                const actions = yield* listDevBoxActions(devBox);
                const snapshots = yield* listDevBoxSnapshots(devBox);
                const operations = yield* listDevBoxOperations(devBox);
                // Capture and restore are accepted before the dev box is looked up;
                // the operation they start fails later.
                const capture = yield* captureDevBoxSnapshot(devBox);
                const restore = yield* restoreDevBoxSnapshot({ ...devBox, snapshotId: ZERO_ID });
                return {
                  actions: actions.value.map((a) => a.name),
                  snapshots: snapshots.value.map((s) => s.snapshotId),
                  operations: operations.value.map((o) => o.operationId),
                  capture: capture.operationLocation ?? "",
                  restore: restore.operationLocation ?? "",
                  getAction: yield* failureTag(getDevBoxAction(action)),
                  skipAction: yield* failureTag(skipDevBoxAction(action)),
                  delayAction: yield* failureTag(delayDevBoxAction({ ...action, until })),
                  delayActions: yield* failureTag(delayDevBoxActions({ ...devBox, until })),
                  getSnapshot: yield* failureTag(
                    getDevBoxSnapshot({ ...devBox, snapshotId: ZERO_ID }),
                  ),
                  repair: yield* failureTag(repairDevBox(devBox)),
                  listGroups: yield* failureTag(listCustomizationGroups(devBox)),
                  getGroup: yield* failureTag(getCustomizationGroup(group)),
                  createGroup: yield* failureTag(
                    createCustomizationGroup({ ...group, tasks: [{ name: TASK }] }),
                  ),
                  taskLog: yield* failureTag(
                    getCustomizationTaskLog({ ...group, customizationTaskId: ZERO_ID }),
                  ),
                  getOperation: yield* failureTag(
                    getDevBoxOperation({ ...devBox, operationId: ZERO_ID }),
                  ),
                };
              }),
            );
          case "/customization-tasks":
            return yield* respond(
              Effect.gen(function* () {
                const page = yield* listTaskDefinitions();
                // `catalog` here is the task catalog (intrinsic tasks cannot be read by name).
                const first = page.value.find((t) => t.catalogName === catalog);
                // A failure here answers its tag, so a wrong task name shows in the result.
                const read =
                  first === undefined
                    ? "none"
                    : yield* getTaskDefinition({
                        catalogName: first.catalogName,
                        taskName: first.name,
                      }).pipe(
                        Effect.map((t) => `${t.catalogName}/${t.name}`),
                        Effect.catch((error) =>
                          PROPAGATING.has(error._tag)
                            ? Effect.fail(error)
                            : Effect.succeed(error._tag),
                        ),
                      );
                const validation = yield* validateTasks({ tasks: [{ name: TASK }] });
                const operationId = operationIdOf(validation.operationLocation);
                const status = yield* getOperationStatus({ operationId });
                return {
                  tasks: page.value.map((t) => `${t.catalogName}/${t.name}`).sort(),
                  read,
                  missing: yield* failureTag(
                    getTaskDefinition({ catalogName: catalog, taskName: MISSING }),
                  ),
                  validation: { operationId, statusName: status.name },
                  missingStatus: yield* failureTag(getOperationStatus({ operationId: ZERO_ID })),
                  imagingLog: yield* failureTag(getImagingTaskLog({ imageBuildLogId: ZERO_ID })),
                };
              }),
            );
          case "/pool-schedules":
            return yield* respond(
              Effect.gen(function* () {
                const page = yield* listSchedulesByPool({ poolName: MISSING });
                return {
                  names: names(page),
                  get: yield* failureTag(
                    getScheduleByPool({ poolName: MISSING, scheduleName: "default" }),
                  ),
                };
              }),
            );
          // The gated dev box lifecycle: one step per call on `LIVE_DEV_BOX`.
          case "/live":
            return yield* respond(liveStep(url.searchParams));
          case "/definitions-by-catalog":
            return yield* respond(
              Effect.map(listDefinitionsByCatalog({ catalogName: catalog }), (page) => ({
                ids: page.value.map((d) => `${d.catalogName}/${d.name}`).sort(),
              })),
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
        Azure.DevCenter.ListDevBoxActionsHttp,
        Azure.DevCenter.GetDevBoxActionHttp,
        Azure.DevCenter.SkipDevBoxActionHttp,
        Azure.DevCenter.DelayDevBoxActionHttp,
        Azure.DevCenter.DelayDevBoxActionsHttp,
        Azure.DevCenter.ListDevBoxSnapshotsHttp,
        Azure.DevCenter.GetDevBoxSnapshotHttp,
        Azure.DevCenter.CaptureDevBoxSnapshotHttp,
        Azure.DevCenter.RestoreDevBoxSnapshotHttp,
        Azure.DevCenter.RepairDevBoxHttp,
        Azure.DevCenter.ListCustomizationGroupsHttp,
        Azure.DevCenter.GetCustomizationGroupHttp,
        Azure.DevCenter.CreateCustomizationGroupHttp,
        Azure.DevCenter.GetCustomizationTaskLogHttp,
        Azure.DevCenter.ListDevBoxOperationsHttp,
        Azure.DevCenter.GetDevBoxOperationHttp,
        Azure.DevCenter.ListCustomizationTaskDefinitionsHttp,
        Azure.DevCenter.GetCustomizationTaskDefinitionHttp,
        Azure.DevCenter.ValidateCustomizationTasksHttp,
        Azure.DevCenter.GetImagingTaskLogHttp,
        Azure.DevCenter.GetOperationStatusHttp,
        Azure.DevCenter.ListSchedulesByPoolHttp,
        Azure.DevCenter.GetScheduleByPoolHttp,
        Azure.DevCenter.ListEnvironmentDefinitionsByCatalogHttp,
      ),
    ),
  ),
) {}
