import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export const DEFAULT_LOCATION = "global";

export const locationParent = (project: string, location = DEFAULT_LOCATION) =>
  `projects/${project}/locations/${location}`;

export const getAgent = (name: string) =>
  dialogflow
    .getProjectsLocationsAgents({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAgents = (parent: string) =>
  dialogflow.listProjectsLocationsAgents.pages({ parent, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.agents ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
    Effect.catchTag("Forbidden", () => Effect.succeed([])),
  );

export const ensureAgent = (
  project: string,
  displayName: string,
  location = DEFAULT_LOCATION,
) =>
  Effect.gen(function* () {
    const parent = locationParent(project, location);
    const agents = yield* listAgents(parent);
    const existing = agents.find((agent) => agent.displayName === displayName);
    if (existing?.name) {
      const current = yield* getAgent(existing.name);
      if (current !== undefined) return current;
    }
    return yield* dialogflow.createProjectsLocationsAgents({
      parent,
      body: {
        displayName,
        defaultLanguageCode: "en",
        timeZone: "America/Los_Angeles",
        description: displayName,
      },
    });
  });

export const deleteAgent = (name: string) =>
  Effect.gen(function* () {
    if (name.length === 0) return;
    const existing = yield* getAgent(name);
    if (existing === undefined) return;
    yield* dialogflow
      .deleteProjectsLocationsAgents({ name })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
  }).pipe(Effect.ignore);

export const getEntityType = (name: string) =>
  dialogflow
    .getProjectsLocationsAgentsEntityTypes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ensureEntityType = (agent: string, displayName: string) =>
  Effect.gen(function* () {
    const listed = yield* dialogflow.listProjectsLocationsAgentsEntityTypes
      .pages({ parent: agent, pageSize: 100 })
      .pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.entityTypes ?? [])),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () => Effect.succeed([])),
        Effect.catchTag("Forbidden", () => Effect.succeed([])),
      );
    const existing = listed.find(
      (entityType) => entityType.displayName === displayName,
    );
    if (existing?.name) {
      const current = yield* getEntityType(existing.name);
      if (current !== undefined) return current;
    }
    return yield* dialogflow.createProjectsLocationsAgentsEntityTypes({
      parent: agent,
      body: {
        displayName,
        kind: "KIND_MAP",
        entities: [{ value: "blue", synonyms: ["blue", "navy"] }],
      },
    });
  });

export const deleteEntityType = (name: string) =>
  dialogflow
    .deleteProjectsLocationsAgentsEntityTypes({ name, force: true })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));
