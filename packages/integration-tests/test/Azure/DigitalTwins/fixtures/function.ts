import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

export const Twins = Azure.DigitalTwins.Instance("DtBindingsTwins");

/** Event Grid topic the instance routes events to. */
export const Topic = Azure.EventGrid.Topic("DtBindingsTopic");

/** Name of the instance's Event Grid endpoint, the target of `AddEventRoute`. */
export const ENDPOINT_NAME = "alchemy-grid";

export const GridEndpoint = Effect.gen(function* () {
  const twins = yield* Twins;
  const topic = yield* Topic;
  return yield* Azure.DigitalTwins.Endpoint("DtBindingsGrid", {
    instance: twins.instanceName,
    name: ENDPOINT_NAME,
    endpointType: "EventGrid",
    topicEndpoint: topic.endpoint,
    accessKey1: topic.primaryKey,
    accessKey2: topic.secondaryKey,
  });
});

export const THERMOSTAT = "dtmi:alchemy:test:Thermostat;1";
export const ROOM = "dtmi:alchemy:test:Room;1";
export const FLOOR = "dtmi:alchemy:test:Floor;1";
/** Uploaded, decommissioned, and deleted by the model routes. */
export const SCRATCH = "dtmi:alchemy:test:Scratch;1";

const MODELS = [
  {
    "@id": THERMOSTAT,
    "@type": "Interface",
    "@context": "dtmi:dtdl:context;3",
    contents: [
      { "@type": "Property", name: "setpoint", schema: "double", writable: true },
      { "@type": "Telemetry", name: "reading", schema: "double" },
    ],
  },
  {
    "@id": ROOM,
    "@type": "Interface",
    "@context": "dtmi:dtdl:context;3",
    contents: [
      { "@type": "Property", name: "temperature", schema: "double", writable: true },
      { "@type": "Telemetry", name: "humidity", schema: "double" },
      { "@type": "Component", name: "thermostat", schema: THERMOSTAT },
    ],
  },
  {
    "@id": FLOOR,
    "@type": "Interface",
    "@context": "dtmi:dtdl:context;3",
    contents: [
      {
        "@type": "Relationship",
        name: "contains",
        target: ROOM,
        properties: [{ "@type": "Property", name: "since", schema: "string", writable: true }],
      },
    ],
  },
  {
    "@id": SCRATCH,
    "@type": "Interface",
    "@context": "dtmi:dtdl:context;3",
    contents: [{ "@type": "Property", name: "note", schema: "string", writable: true }],
  },
];

export const ROOM_ID = "room-1";
export const FLOOR_ID = "floor-1";
export const RELATIONSHIP_ID = "floor-1-contains-room-1";
export const ROUTE_ID = "alchemy-route";
export const IMPORT_JOB_ID = "alchemy-import";

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/** The `_tag` an effect fails with (`"none"` when it succeeds). */
const failureTag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.as("none"),
    Effect.catch((error) => Effect.succeed(error._tag)),
  );

/**
 * The `_tag` a probe for a missing entity fails with. Digital Twins answers
 * `Forbidden` until a new role assignment reaches it, so fail (and let the
 * caller retry) on `Forbidden`.
 */
const missingTag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  failureTag(effect).pipe(
    Effect.flatMap((tag) =>
      tag === "Forbidden"
        ? Effect.fail(new Error("Forbidden: the role assignment has not reached Digital Twins yet"))
        : Effect.succeed(tag),
    ),
  );

/**
 * Effect-native Azure Function exercising every Digital Twins data-plane
 * binding on a managed-identity host, one route per behavior. Routes answer
 * `{ ok, result | error }` with a 500 on error, so a caller retries through
 * the cold start and role propagation, and a real failure shows the Azure
 * error.
 */
export default class DtFunction extends Azure.Functions.Function<DtFunction>()(
  "DtBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const twins = yield* Twins;

    const addModels = yield* Azure.DigitalTwins.AddDigitalTwinModels(twins);
    const getModel = yield* Azure.DigitalTwins.GetDigitalTwinModel(twins);
    const listModels = yield* Azure.DigitalTwins.ListDigitalTwinModels(twins);
    const updateModel = yield* Azure.DigitalTwins.UpdateDigitalTwinModel(twins);
    const deleteModel = yield* Azure.DigitalTwins.DeleteDigitalTwinModel(twins);

    const addTwin = yield* Azure.DigitalTwins.AddDigitalTwin(twins);
    const getTwin = yield* Azure.DigitalTwins.GetDigitalTwin(twins);
    const updateTwin = yield* Azure.DigitalTwins.UpdateDigitalTwin(twins);
    const deleteTwin = yield* Azure.DigitalTwins.DeleteDigitalTwin(twins);
    const getComponent = yield* Azure.DigitalTwins.GetDigitalTwinComponent(twins);
    const updateComponent = yield* Azure.DigitalTwins.UpdateDigitalTwinComponent(twins);
    const sendTelemetry = yield* Azure.DigitalTwins.SendDigitalTwinTelemetry(twins);
    const sendComponentTelemetry =
      yield* Azure.DigitalTwins.SendDigitalTwinComponentTelemetry(twins);

    const addRelationship = yield* Azure.DigitalTwins.AddDigitalTwinRelationship(twins);
    const getRelationship = yield* Azure.DigitalTwins.GetDigitalTwinRelationship(twins);
    const updateRelationship = yield* Azure.DigitalTwins.UpdateDigitalTwinRelationship(twins);
    const deleteRelationship = yield* Azure.DigitalTwins.DeleteDigitalTwinRelationship(twins);
    const listRelationships = yield* Azure.DigitalTwins.ListDigitalTwinRelationships(twins);
    const listIncoming = yield* Azure.DigitalTwins.ListDigitalTwinIncomingRelationships(twins);

    const queryTwins = yield* Azure.DigitalTwins.QueryTwins(twins);

    const addRoute = yield* Azure.DigitalTwins.AddEventRoute(twins);
    const getRoute = yield* Azure.DigitalTwins.GetEventRoute(twins);
    const listRoutes = yield* Azure.DigitalTwins.ListEventRoutes(twins);
    const deleteRoute = yield* Azure.DigitalTwins.DeleteEventRoute(twins);

    const addImport = yield* Azure.DigitalTwins.AddImportJob(twins);
    const getImport = yield* Azure.DigitalTwins.GetImportJob(twins);
    const listImports = yield* Azure.DigitalTwins.ListImportJobs(twins);
    const cancelImport = yield* Azure.DigitalTwins.CancelImportJob(twins);
    const deleteImport = yield* Azure.DigitalTwins.DeleteImportJob(twins);

    const addDeleteJob = yield* Azure.DigitalTwins.AddDeleteJob(twins);
    const getDeleteJob = yield* Azure.DigitalTwins.GetDeleteJob(twins);
    const listDeleteJobs = yield* Azure.DigitalTwins.ListDeleteJobs(twins);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        switch (url.pathname) {
          case "/models/add":
            return yield* respond(
              addModels({ body: MODELS }).pipe(
                Effect.map((models) => ({ added: models.map((m) => m.id).sort() })),
                // A retried call (or a kept stack) finds some models already
                // there: upload the rest one at a time, in dependency order.
                Effect.catchTag("DigitalTwinModelAlreadyExists", () =>
                  Effect.forEach(MODELS, (model) =>
                    addModels({ body: [model] }).pipe(
                      Effect.as(true),
                      Effect.catchTag("DigitalTwinModelAlreadyExists", () => Effect.succeed(false)),
                    ),
                  ).pipe(Effect.map((added) => ({ added: added.filter(Boolean).length }))),
                ),
              ),
            );
          case "/models/get":
            return yield* respond(
              Effect.map(getModel({ id: ROOM, includeModelDefinition: true }), (model) => ({
                id: model.id,
                hasDefinition: model.model !== undefined,
                missing: "pending",
              })).pipe(
                Effect.flatMap((found) =>
                  Effect.map(
                    missingTag(getModel({ id: "dtmi:alchemy:test:Missing;1" })),
                    (missing) => ({ ...found, missing }),
                  ),
                ),
              ),
            );
          case "/models/list":
            return yield* respond(
              Effect.map(listModels(), (page) => ({ ids: page.value.map((m) => m.id).sort() })),
            );
          case "/models/decommission":
            return yield* respond(
              updateModel({
                id: SCRATCH,
                body: [{ op: "replace", path: "/decommissioned", value: true }],
              }),
            );
          case "/models/delete":
            return yield* respond(deleteModel({ id: SCRATCH }));
          case "/twins/add":
            return yield* respond(
              Effect.gen(function* () {
                const room = yield* addTwin({
                  id: ROOM_ID,
                  body: {
                    $metadata: { $model: ROOM },
                    temperature: 21,
                    thermostat: { $metadata: {}, setpoint: 20 },
                  },
                });
                const floor = yield* addTwin({
                  id: FLOOR_ID,
                  body: { $metadata: { $model: FLOOR } },
                });
                return { room: room.$dtId, floor: floor.$dtId };
              }),
            );
          case "/twins/get":
            return yield* respond(
              Effect.gen(function* () {
                const room = yield* getTwin({ id: ROOM_ID });
                const missing = yield* missingTag(getTwin({ id: "no-such-twin" }));
                return { id: room.$dtId, temperature: room.temperature, missing };
              }),
            );
          case "/twins/update":
            return yield* respond(
              updateTwin({
                id: ROOM_ID,
                body: [{ op: "replace", path: "/temperature", value: 22 }],
              }),
            );
          case "/component/get":
            return yield* respond(
              Effect.map(getComponent({ id: ROOM_ID, componentPath: "thermostat" }), (c) => ({
                setpoint: c.setpoint,
              })),
            );
          case "/component/update":
            return yield* respond(
              updateComponent({
                id: ROOM_ID,
                componentPath: "thermostat",
                body: [{ op: "replace", path: "/setpoint", value: 19 }],
              }),
            );
          case "/telemetry":
            return yield* respond(
              Effect.gen(function* () {
                yield* sendTelemetry({ id: ROOM_ID, messageId: "t-1", body: { humidity: 40 } });
                const missing = yield* missingTag(
                  sendTelemetry({ id: "no-such-twin", messageId: "t-2", body: { humidity: 1 } }),
                );
                return { sent: true, missing };
              }),
            );
          case "/component-telemetry":
            return yield* respond(
              Effect.gen(function* () {
                yield* sendComponentTelemetry({
                  id: ROOM_ID,
                  componentPath: "thermostat",
                  messageId: "c-1",
                  body: { reading: 19.5 },
                });
                return { sent: true };
              }),
            );
          case "/relationships/add":
            return yield* respond(
              Effect.map(
                addRelationship({
                  id: FLOOR_ID,
                  relationshipId: RELATIONSHIP_ID,
                  body: { $relationshipName: "contains", $targetId: ROOM_ID },
                }),
                (r) => ({ id: r.$relationshipId, target: r.$targetId }),
              ),
            );
          case "/relationships/get":
            return yield* respond(
              Effect.gen(function* () {
                const r = yield* getRelationship({ id: FLOOR_ID, relationshipId: RELATIONSHIP_ID });
                const missing = yield* missingTag(
                  getRelationship({ id: FLOOR_ID, relationshipId: "no-such-relationship" }),
                );
                return { name: r.$relationshipName, since: r.since, missing };
              }),
            );
          case "/relationships/update":
            return yield* respond(
              updateRelationship({
                id: FLOOR_ID,
                relationshipId: RELATIONSHIP_ID,
                body: [{ op: "add", path: "/since", value: "2026-01-01" }],
              }),
            );
          case "/relationships/list":
            return yield* respond(
              Effect.map(listRelationships({ id: FLOOR_ID }), (page) => ({
                ids: page.value.map((r) => (r as { $relationshipId?: string }).$relationshipId),
              })),
            );
          case "/relationships/incoming":
            return yield* respond(
              Effect.map(listIncoming({ id: ROOM_ID }), (page) => ({
                sources: page.value.map((r) => r._sourceId),
              })),
            );
          case "/relationships/delete":
            return yield* respond(
              deleteRelationship({ id: FLOOR_ID, relationshipId: RELATIONSHIP_ID }),
            );
          case "/query":
            return yield* respond(
              Effect.map(
                queryTwins({ query: `SELECT * FROM digitaltwins WHERE IS_OF_MODEL('${ROOM}')` }),
                (result) => ({
                  ids: result.value.map((t) => (t as { $dtId?: string }).$dtId),
                }),
              ),
            );
          case "/routes/add":
            return yield* respond(
              addRoute({ id: ROUTE_ID, endpointName: ENDPOINT_NAME, filter: "true" }),
            );
          case "/routes/get":
            return yield* respond(getRoute({ id: ROUTE_ID }));
          case "/routes/list":
            return yield* respond(
              Effect.map(listRoutes(), (page) => ({ ids: page.value.map((r) => r.id) })),
            );
          case "/routes/delete":
            return yield* respond(deleteRoute({ id: ROUTE_ID }));
          case "/imports/add":
            return yield* respond(
              Effect.map(
                addImport({
                  id: IMPORT_JOB_ID,
                  inputBlobUri: param("input"),
                  outputBlobUri: param("output"),
                }),
                (job) => ({ id: job.id, status: job.status }),
              ),
            );
          case "/imports/get":
            return yield* respond(
              Effect.map(getImport({ id: IMPORT_JOB_ID }), (job) => ({
                id: job.id,
                status: job.status,
              })),
            );
          case "/imports/list":
            return yield* respond(
              Effect.map(listImports(), (page) => ({ ids: page.value.map((j) => j.id) })),
            );
          case "/imports/cancel":
            return yield* respond(
              Effect.map(failureTag(cancelImport({ id: IMPORT_JOB_ID })), (tag) => ({ tag })),
            );
          case "/imports/delete":
            return yield* respond(deleteImport({ id: IMPORT_JOB_ID }));
          case "/deletejobs/add":
            return yield* respond(addDeleteJob({ operationId: param("id") }));
          case "/deletejobs/get":
            return yield* respond(
              Effect.map(getDeleteJob({ id: param("id") }), (job) => ({
                id: job.id,
                status: job.status,
              })),
            );
          case "/deletejobs/list":
            return yield* respond(
              Effect.map(listDeleteJobs(), (page) => ({ ids: page.value.map((j) => j.id) })),
            );
          case "/twins/delete":
            return yield* respond(
              Effect.gen(function* () {
                yield* deleteTwin({ id: ROOM_ID });
                yield* deleteTwin({ id: FLOOR_ID });
                return { deleted: [ROOM_ID, FLOOR_ID] };
              }),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.DigitalTwins.AddDigitalTwinModelsHttp,
        Azure.DigitalTwins.GetDigitalTwinModelHttp,
        Azure.DigitalTwins.ListDigitalTwinModelsHttp,
        Azure.DigitalTwins.UpdateDigitalTwinModelHttp,
        Azure.DigitalTwins.DeleteDigitalTwinModelHttp,
        Azure.DigitalTwins.AddDigitalTwinHttp,
        Azure.DigitalTwins.GetDigitalTwinHttp,
        Azure.DigitalTwins.UpdateDigitalTwinHttp,
        Azure.DigitalTwins.DeleteDigitalTwinHttp,
        Azure.DigitalTwins.GetDigitalTwinComponentHttp,
        Azure.DigitalTwins.UpdateDigitalTwinComponentHttp,
        Azure.DigitalTwins.SendDigitalTwinTelemetryHttp,
        Azure.DigitalTwins.SendDigitalTwinComponentTelemetryHttp,
        Azure.DigitalTwins.AddDigitalTwinRelationshipHttp,
        Azure.DigitalTwins.GetDigitalTwinRelationshipHttp,
        Azure.DigitalTwins.UpdateDigitalTwinRelationshipHttp,
        Azure.DigitalTwins.DeleteDigitalTwinRelationshipHttp,
        Azure.DigitalTwins.ListDigitalTwinRelationshipsHttp,
        Azure.DigitalTwins.ListDigitalTwinIncomingRelationshipsHttp,
        Azure.DigitalTwins.QueryTwinsHttp,
        Azure.DigitalTwins.AddEventRouteHttp,
        Azure.DigitalTwins.GetEventRouteHttp,
        Azure.DigitalTwins.ListEventRoutesHttp,
        Azure.DigitalTwins.DeleteEventRouteHttp,
        Azure.DigitalTwins.AddImportJobHttp,
        Azure.DigitalTwins.GetImportJobHttp,
        Azure.DigitalTwins.ListImportJobsHttp,
        Azure.DigitalTwins.CancelImportJobHttp,
        Azure.DigitalTwins.DeleteImportJobHttp,
        Azure.DigitalTwins.AddDeleteJobHttp,
        Azure.DigitalTwins.GetDeleteJobHttp,
        Azure.DigitalTwins.ListDeleteJobsHttp,
      ),
    ),
  ),
) {}
