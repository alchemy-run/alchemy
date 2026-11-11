import * as DO from "@distilled.cloud/digitalocean";
import type { AgentConfig } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type EnvironmentConfigProps = {
  /**
   * Config name, unique among the team's active configs. A change replaces
   * the config.
   *
   * @default a generated physical name
   */
  name?: string;
  /**
   * The environment spec: YAML text, or an object Alchemy sends as JSON
   * (JSON is YAML). It names the agent runtime adapter, sandbox, tools and
   * secrets. Configs are immutable, so a change replaces the config.
   */
  manifest: string | Record<string, unknown>;
  /** Which telemetry the sessions send to Insights. A change replaces the config. */
  insights?: { metrics?: boolean; logs?: boolean; traces?: boolean };
};

export type EnvironmentConfig = Resource<
  "DigitalOcean.Agents.EnvironmentConfig",
  EnvironmentConfigProps,
  {
    /** Config id; pass it as a session's `config_id`. */
    configId: string;
    /** Config name. */
    name: string;
    /** Hash DigitalOcean computes over the stored manifest. */
    contentHash: string;
  },
  never,
  Providers
>;

export type EnvironmentConfigAttributes = EnvironmentConfig["Attributes"];

/**
 * A Harness Runtime environment config: the immutable spec of an agent
 * environment (runtime adapter, sandbox, tools, secrets) that sessions start
 * from. DigitalOcean never updates a config, so any change replaces it; a
 * replaced config stays resolvable for sessions already running on it.
 *
 * ### Defining an Environment
 * **Example:** An OpenCode agent environment
 * ```typescript
 * const env = yield* DigitalOcean.Agents.EnvironmentConfig("coder", {
 *   manifest: {
 *     apiVersion: "agents.digitalocean.com/v1alpha1",
 *     kind: "Agent",
 *     spec: { runtime: { adapter: "opencode" } },
 *   },
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Harness-Runtime
 *
 * @resource
 * @product Harness Runtime
 * @category AI
 */
export const EnvironmentConfig = Resource<EnvironmentConfig>(
  "DigitalOcean.Agents.EnvironmentConfig",
);

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 64 });

const manifestText = (manifest: EnvironmentConfigProps["manifest"]) =>
  typeof manifest === "string" ? manifest : JSON.stringify(manifest);

const toAttrs = (config: AgentConfig): EnvironmentConfigAttributes => ({
  configId: config.id,
  name: config.name,
  contentHash: config.content_hash,
});

const observe = (configId: string) =>
  noneIfNotFound(DO.getHarnessConfig({ config_id: configId }).pipe(Effect.map((r) => r.config)));

export const EnvironmentConfigProvider = () =>
  Provider.succeed(EnvironmentConfig, {
    stables: ["configId", "contentHash"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(output.configId);
      return Option.getOrUndefined(Option.map(observed, toAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (
        news.name !== olds.name ||
        manifestText(news.manifest) !== manifestText(olds.manifest) ||
        JSON.stringify(news.insights ?? {}) !== JSON.stringify(olds.insights ?? {})
      ) {
        // A chosen name stays taken until the old config is deleted.
        return { action: "replace", deleteFirst: news.name !== undefined } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      if (output !== undefined) {
        const observed = yield* observe(output.configId);
        if (Option.isSome(observed)) return toAttrs(observed.value);
      }
      const name = news.name ?? (yield* physicalName(id));
      const { config } = yield* DO.createHarnessConfig({
        name,
        manifest_yaml: manifestText(news.manifest),
        insights: news.insights,
      });
      return toAttrs(config);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteHarnessConfig({ config_id: output.configId }));
    }),
  });
