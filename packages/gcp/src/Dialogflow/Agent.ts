import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  encodeOwnership,
  hasOwnershipMarker,
  internalLabels,
  lastSegment,
  listAgents,
  locationOf,
  locationParent,
  namedAgents,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  projectOf,
  retryQuota,
  sameJson,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./internal.ts";

export type AgentProps = {
  /**
   * Location of the agent (`global`, `us-central1`, …). Immutable —
   * changing it replaces the agent.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable name, unique within the location. If omitted, a unique
   * name is generated.
   */
  displayName?: string;
  /**
   * Language the agent understands by default (`en`, `de`, …). Immutable —
   * changing it replaces the agent.
   * @default "en"
   */
  defaultLanguageCode?: string;
  /**
   * IANA time zone the agent resolves dates in.
   * @default "America/Los_Angeles"
   */
  timeZone?: string;
  /** Description. Alchemy records its ownership marker ahead of it. */
  description?: string;
  /** Further languages the agent understands, besides `defaultLanguageCode`. */
  supportedLanguageCodes?: string[];
  /** Whether to correct spelling in user input. */
  enableSpellCorrection?: boolean;
  /** Whether to send conversation logs to Cloud Logging. */
  enableStackdriverLogging?: boolean;
  /** Security settings (`…/securitySettings/{id}`) the agent applies. */
  securitySettings?: string;
};

export type Agent = Resource<
  "GCP.Dialogflow.Agent",
  AgentProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/agents/{agent}`. */
    name: string;
    /** Server-assigned agent id (last path segment). */
    agentId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string;
    /** Default language. */
    defaultLanguageCode: string;
    /** Time zone. */
    timeZone: string;
    /** Description with the Alchemy ownership marker stripped. */
    description: string | undefined;
    /** Further supported languages. */
    supportedLanguageCodes: string[];
    /** The agent's default start flow, `…/flows/00000000-0000-0000-0000-000000000000`. */
    startFlow: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX agent: the container for flows, pages, intents, entity
 * types, webhooks, playbooks and tools.
 *
 * Agent ids are assigned by Google and agents have no labels, so Alchemy
 * records its ownership marker in `description` and finds the agent by name
 * from state. Location and default language are fixed; display name, time
 * zone, description, languages and logging settings update in place. Every
 * child resource takes the agent's `name`.
 *
 * ### Creating an Agent
 * **Example:** An English agent
 * ```typescript
 * const agent = yield* GCP.Dialogflow.Agent("Support", {
 *   displayName: "support",
 * });
 * ```
 *
 * **Example:** A regional, multilingual agent
 * ```typescript
 * const agent = yield* GCP.Dialogflow.Agent("Support", {
 *   location: "us-central1",
 *   displayName: "support",
 *   defaultLanguageCode: "en",
 *   supportedLanguageCodes: ["es", "fr"],
 *   timeZone: "Europe/Paris",
 * });
 * ```
 *
 * ### Building on the Agent
 * **Example:** A webhook on the agent
 * ```typescript
 * const webhook = yield* GCP.Dialogflow.AgentsWebhook("Fulfillment", {
 *   agent: agent.name,
 *   displayName: "orders",
 *   genericWebService: { uri: "https://example.com/dialogflow" },
 * });
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const Agent = Resource<Agent>("GCP.Dialogflow.Agent");

export class AgentNotResolved extends Data.TaggedError("GCP.Dialogflow.AgentNotResolved")<{
  resourceName: string;
}> {}

const DEFAULT_LANGUAGE = "en";
const DEFAULT_TIME_ZONE = "America/Los_Angeles";

const toAttrs = (agent: dialogflow.GoogleCloudDialogflowCxV3Agent, project: string) => {
  const name = agent.name ?? "";
  return {
    name,
    agentId: lastSegment(name),
    project: projectOf(name) || project,
    location: locationOf(name),
    displayName: agent.displayName ?? "",
    defaultLanguageCode: agent.defaultLanguageCode ?? DEFAULT_LANGUAGE,
    timeZone: agent.timeZone ?? DEFAULT_TIME_ZONE,
    description: parseOwnership(agent.description).text,
    supportedLanguageCodes: [...(agent.supportedLanguageCodes ?? [])],
    startFlow: agent.startFlow,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.undefined
    : dialogflow
        .getProjectsLocationsAgents({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** An agent this logical id owns, found by its ownership marker. */
const findOwned = (id: string, project: string, location: string) =>
  Effect.gen(function* () {
    const agents = yield* listAgents(project, location);
    for (const agent of agents) {
      if (yield* ownedByAlchemy(id, agent.description)) return agent;
    }
    return undefined;
  });

export const AgentProvider = () =>
  Provider.succeed(Agent, {
    stables: ["name", "agentId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = olds?.location ?? output?.location;
      const previousLanguage =
        olds?.defaultLanguageCode ?? output?.defaultLanguageCode ?? DEFAULT_LANGUAGE;
      if (
        (previousLocation !== undefined &&
          normalizeLocation(previousLocation) !==
            normalizeLocation(news.location ?? DEFAULT_LOCATION)) ||
        (news.defaultLanguageCode ?? DEFAULT_LANGUAGE) !== previousLanguage
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const existing =
        (yield* getByName(output?.name ?? "")) ?? (yield* findOwned(id, env.project, location));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const agents = yield* namedAgents(env.project);
        return agents
          .filter((agent) => hasOwnershipMarker(agent.description))
          .map((agent) => toAttrs(agent, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location ?? DEFAULT_LOCATION);
      const displayName =
        news.displayName ?? output?.displayName ?? (yield* toResourceId(id, undefined, undefined));
      const description = encodeOwnership(yield* internalLabels(id), news.description);
      const body: dialogflow.GoogleCloudDialogflowCxV3Agent = {
        displayName,
        defaultLanguageCode: news.defaultLanguageCode ?? DEFAULT_LANGUAGE,
        timeZone: news.timeZone ?? DEFAULT_TIME_ZONE,
        description,
        supportedLanguageCodes: news.supportedLanguageCodes,
        enableSpellCorrection: news.enableSpellCorrection,
        enableStackdriverLogging: news.enableStackdriverLogging,
        securitySettings: news.securitySettings,
      };

      // Observe: by name from state, else an agent this id already owns
      // (a create whose state write was lost).
      let current =
        (yield* getByName(output?.name ?? "")) ?? (yield* findOwned(id, env.project, location));

      // Ensure
      if (current === undefined) {
        current = yield* dialogflow.createProjectsLocationsAgents({
          parent: locationParent(env.project, location),
          body,
        });
      } else {
        // Sync the mutable fields against what the agent has now.
        const mask = updateMaskOf(
          sameText(current.displayName, displayName) ? undefined : "display_name",
          sameText(current.timeZone, body.timeZone) ? undefined : "time_zone",
          sameText(current.description, description) ? undefined : "description",
          news.supportedLanguageCodes === undefined ||
            sameJson(current.supportedLanguageCodes ?? [], news.supportedLanguageCodes)
            ? undefined
            : "supported_language_codes",
          news.enableSpellCorrection === undefined ||
            (current.enableSpellCorrection === true) === news.enableSpellCorrection
            ? undefined
            : "enable_spell_correction",
          news.enableStackdriverLogging === undefined ||
            (current.enableStackdriverLogging === true) === news.enableStackdriverLogging
            ? undefined
            : "enable_stackdriver_logging",
          news.securitySettings === undefined ||
            sameText(current.securitySettings, news.securitySettings)
            ? undefined
            : "security_settings",
        );
        if (mask.length > 0) {
          current = yield* dialogflow.patchProjectsLocationsAgents({
            name: current.name ?? "",
            updateMask: mask,
            body: { ...body, name: current.name },
          });
        }
      }

      if (current?.name === undefined) {
        return yield* new AgentNotResolved({ resourceName: locationParent(env.project, location) });
      }
      return toAttrs(current, env.project);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* dialogflow
        .deleteProjectsLocationsAgents({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });
