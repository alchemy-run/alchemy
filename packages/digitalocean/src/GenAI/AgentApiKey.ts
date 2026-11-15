import * as DO from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { ignoreNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type AgentApiKeyProps = {
  /** The agent the key calls. A change replaces the key. */
  agentId: string;
  /**
   * Key name.
   *
   * @default a generated physical name
   */
  name?: string;
};

export type AgentApiKey = Resource<
  "DigitalOcean.GenAI.AgentApiKey",
  AgentApiKeyProps,
  {
    /** Key UUID. */
    apiKeyId: string;
    /** The agent the key calls. */
    agentId: string;
    /** Key name. */
    name: string;
    /** The key callers send as `Authorization: Bearer <key>`. Returned only at create. */
    secretKey: Redacted.Redacted<string>;
  },
  never,
  Providers
>;

/**
 * A key that authorizes calls to one GenAI agent's endpoint. DigitalOcean
 * returns the secret only at create, so Alchemy keeps it in state as a
 * `Redacted` value. Pass it to `InvokeAgent`, or to any OpenAI-compatible
 * client as the API key.
 *
 * ### Calling an Agent
 * **Example:** A key for an agent
 * ```typescript
 * const key = yield* DigitalOcean.GenAI.AgentApiKey("support-key", {
 *   agentId: agent.agentId,
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#operation/genai_create_agent_api_key
 *
 * @resource
 * @product GenAI Platform
 * @category AI
 */
export const AgentApiKey = Resource<AgentApiKey>("DigitalOcean.GenAI.AgentApiKey");

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const observe = (agentId: string, apiKeyId: string) =>
  DO.listGenaiAgentApiKeys.items({ agent_uuid: agentId, per_page: 200 }).pipe(
    Stream.filter((key) => key.uuid === apiKeyId),
    Stream.runHead,
    Effect.catchTag("NotFound", () => Effect.succeedNone),
  );

export const AgentApiKeyProvider = () =>
  Provider.succeed(AgentApiKey, {
    stables: ["apiKeyId", "agentId", "secretKey"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(output.agentId, output.apiKeyId);
      return Option.isSome(observed) ? output : undefined;
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!("agentId" in news) || !isResolved(news.agentId) || news.agentId !== olds.agentId) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      if (output !== undefined && Option.isSome(yield* observe(output.agentId, output.apiKeyId))) {
        return output;
      }
      const name = news.name ?? (yield* physicalName(id));
      const { api_key_info: key } = yield* DO.createGenaiAgentApiKey({
        agent_uuid: news.agentId,
        name,
      });
      return {
        apiKeyId: key.uuid,
        agentId: news.agentId,
        name: key.name,
        secretKey:
          typeof key.secret_key === "string"
            ? Redacted.make(key.secret_key)
            : (key.secret_key ?? Redacted.make("")),
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        DO.deleteGenaiAgentApiKey({ agent_uuid: output.agentId, api_key_uuid: output.apiKeyId }),
      );
    }),
  });
