import * as botservice from "@distilled.cloud/azure/botservice";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  DeleteTimedOut,
  ensureRegistered,
  hasAnyAlchemyTag,
  NOT_FOUND_TAGS,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  botOwnedByStack,
  DEFAULT_BOT_LOCATION,
  reveal,
  sameArm,
} from "./Common.ts";

export interface ConnectionProps {
  /** Resource group of the bot. Changing it replaces the connection. */
  resourceGroup: string;
  /** Name of the bot the connection belongs to. Changing it replaces the connection. */
  bot: string;
  /**
   * Connection name: letters, digits, `-`, and `_`. Bot code requests user
   * tokens by this name. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the connection.
   */
  name?: string;
  /**
   * OAuth service provider: its `serviceProviderName`, matched
   * case-insensitively (e.g. `Aadv2`, `oauth2`, `github`,
   * `oauth2generic`) or its ID from
   * `ListBotConnectionServiceProviders`. Changing it replaces the
   * connection.
   */
  serviceProvider: string;
  /** OAuth client (application) ID. */
  clientId: string;
  /** OAuth client secret. */
  clientSecret: Redacted.Redacted<string>;
  /** Space-separated OAuth scopes. */
  scopes?: string;
  /**
   * Provider-specific parameters, e.g. `{ tenantID: "...", tokenExchangeUrl: "..." }`
   * for `Aadv2`, or the authorization/token URLs for `oauth2generic`.
   */
  parameters?: Record<string, string>;
  /**
   * Location of the connection; must match the bot's. Changing it replaces
   * the connection.
   * @default "global"
   */
  location?: string;
}

export interface Connection extends Resource<
  "Azure.BotService.Connection",
  ConnectionProps,
  {
    /** Name of the connection. */
    connectionName: string;
    /** ARM resource ID of the connection. */
    connectionId: string;
    /** Name of the bot. */
    bot: string;
    /** Resource group of the bot. */
    resourceGroup: string;
    /** Location of the connection. */
    location: string;
    /** Setting ID assigned by the Bot Service. */
    settingId: string | undefined;
    /** ID of the OAuth service provider. */
    serviceProviderId: string;
    /** Display name of the OAuth service provider. */
    serviceProviderDisplayName: string | undefined;
    /** OAuth client ID. */
    clientId: string | undefined;
    /** OAuth scopes. */
    scopes: string | undefined;
    /** Provider-specific parameters as stored by Azure. */
    parameters: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An OAuth connection setting on an Azure Bot. Bot code uses it to sign
 * users in and obtain tokens for an identity provider (Microsoft Entra ID,
 * GitHub, a generic OAuth 2 server, ...) through the Bot Framework token
 * service.
 *
 * Connections cannot be tagged (Azure reports the bot's tags): a connection
 * is owned by whoever owns its bot.
 *
 * @see https://learn.microsoft.com/azure/bot-service/bot-builder-concept-authentication
 *
 * ### Creating a Connection
 * **Example:** Microsoft Entra ID (AADv2) connection
 * ```typescript
 * const connection = yield* Azure.BotService.Connection("graph", {
 *   resourceGroup: group.resourceGroupName,
 *   bot: bot.botName,
 *   serviceProvider: "Aadv2",
 *   clientId: "00000000-0000-0000-0000-000000000000",
 *   clientSecret: Redacted.make(process.env.GRAPH_CLIENT_SECRET!),
 *   scopes: "openid profile User.Read",
 *   parameters: { tenantID: "common" },
 * });
 * ```
 *
 * **Example:** GitHub connection
 * ```typescript
 * yield* Azure.BotService.Connection("github", {
 *   resourceGroup: group.resourceGroupName,
 *   bot: bot.botName,
 *   serviceProvider: "GitHub",
 *   clientId: githubClientId,
 *   clientSecret: githubClientSecret,
 *   scopes: "repo",
 * });
 * ```
 *
 * @resource
 */
export const Connection = Resource<Connection>("Azure.BotService.Connection");

export class BotServiceProviderNotFound extends Data.TaggedError(
  "Azure.BotService.ServiceProviderNotFound",
)<{ readonly serviceProvider: string; readonly message: string }> {}

const createConnectionName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 64 });
  return name.replace(/[^a-zA-Z0-9_-]/g, "-");
});

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  connectionName: string,
) =>
  orUndefinedIfNotFound(
    botservice.GetBotConnection({
      subscriptionId,
      resourceGroupName,
      resourceName,
      connectionName,
    }),
  );

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a service provider name (e.g. `Aadv2`) to its ID. */
const resolveServiceProviderId = Effect.fn(function* (
  subscriptionId: string,
  serviceProvider: string,
) {
  if (GUID.test(serviceProvider)) return serviceProvider;
  const providers = yield* botservice.ListBotConnectionServiceProviders({
    subscriptionId,
  });
  const match = (providers.value ?? []).find(
    (p) =>
      sameArm(p.properties?.serviceProviderName, serviceProvider) ||
      sameArm(p.properties?.displayName, serviceProvider),
  );
  if (match?.properties?.id === undefined) {
    return yield* new BotServiceProviderNotFound({
      serviceProvider,
      message: `No Bot Service OAuth provider named '${serviceProvider}'`,
    });
  }
  return match.properties.id;
});

type ObservedConnection =
  | botservice.GetBotConnectionResponse
  | botservice.ConnectionSetting;

const parametersOf = (connection: ObservedConnection | undefined) =>
  Object.fromEntries(
    (connection?.properties?.parameters ?? []).flatMap((p) =>
      p.key !== undefined && p.value != null ? [[p.key, p.value]] : [],
    ),
  ) as Record<string, string>;

const toAttrs = (
  resourceGroup: string,
  bot: string,
  name: string,
  connection: ObservedConnection,
): Connection["Attributes"] => ({
  connectionName: name,
  connectionId: connection.id ?? "",
  bot,
  resourceGroup,
  location: connection.location ?? DEFAULT_BOT_LOCATION,
  settingId: connection.properties?.settingId,
  serviceProviderId: connection.properties?.serviceProviderId ?? "",
  serviceProviderDisplayName: connection.properties?.serviceProviderDisplayName,
  clientId: connection.properties?.clientId,
  scopes: connection.properties?.scopes,
  parameters: parametersOf(connection),
});

export const ConnectionProvider = () =>
  Provider.succeed(Connection, {
    stables: [
      "connectionName",
      "connectionId",
      "bot",
      "resourceGroup",
      "location",
      "serviceProviderId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const bots = yield* botservice
        .ListBots({ subscriptionId })
        .pipe(Effect.flatMap((page) => requireSinglePage("ListBots", page)));
      const found: Connection["Attributes"][] = [];
      for (const bot of bots.value ?? []) {
        const group = resourceGroupOf(bot.id);
        if (group === undefined || bot.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          botservice.ListBotConnectionByBotService({
            subscriptionId,
            resourceGroupName: group,
            resourceName: bot.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage("ListBotConnectionByBotService", page);
        }
        for (const connection of page?.value ?? []) {
          const name = connection.name?.split("/").pop();
          if (hasAnyAlchemyTag(bot.tags) && name !== undefined) {
            found.push(toAttrs(group, bot.name, name, connection));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      // A name and an ID can denote the same provider, so compare against
      // the previous input and, for IDs, the observed ID.
      const providerChanged = GUID.test(news.serviceProvider)
        ? !sameArm(news.serviceProvider, output.serviceProviderId)
        : olds !== undefined &&
          !sameArm(news.serviceProvider, olds.serviceProvider);
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.bot, output.bot) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.connectionName)) ||
        !sameArm(news.location ?? DEFAULT_BOT_LOCATION, output.location) ||
        providerChanged
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const bot = output?.bot ?? olds?.bot;
      if (resourceGroup === undefined || bot === undefined) return undefined;
      const name =
        output?.connectionName ??
        olds?.name ??
        (yield* createConnectionName(id));
      const observed = yield* getConnection(
        subscriptionId,
        resourceGroup,
        bot,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, bot, name, observed);
      return (yield* botOwnedByStack(subscriptionId, resourceGroup, bot))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.BotService");
      const { resourceGroup, bot } = news;
      const name =
        news.name ??
        output?.connectionName ??
        (yield* createConnectionName(id));
      const location = news.location ?? DEFAULT_BOT_LOCATION;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: bot,
        connectionName: name,
      };
      const get = getConnection(subscriptionId, resourceGroup, bot, name);

      // Observe.
      let observed: ObservedConnection | undefined = yield* get;

      const serviceProviderId =
        observed?.properties?.serviceProviderId ??
        (yield* resolveServiceProviderId(subscriptionId, news.serviceProvider));
      const desiredParameters = news.parameters ?? {};
      const properties = {
        serviceProviderId,
        clientId: news.clientId,
        clientSecret: reveal(news.clientSecret),
        scopes: news.scopes,
        parameters: Object.entries(desiredParameters).map(([key, value]) => ({
          key,
          value,
        })),
      };

      // Ensure. Connection creation is synchronous.
      if (observed === undefined) {
        observed = yield* botservice.CreateBotConnection({
          ...where,
          location,
          properties,
        });
      } else {
        // Sync against the observed connection. The client secret is
        // write-only, so previous props are the only hint of its value.
        const current = observed.properties;
        const observedParameters = parametersOf(observed);
        const changed =
          current?.clientId !== news.clientId ||
          (current?.scopes ?? "") !== (news.scopes ?? "") ||
          Object.entries(desiredParameters).some(
            ([key, value]) => observedParameters[key] !== value,
          ) ||
          reveal(olds?.clientSecret) !== reveal(news.clientSecret);
        if (changed) {
          // The update replaces the whole setting, so send all fields.
          observed = yield* botservice.UpdateBotConnection({
            ...where,
            location,
            properties,
          });
        }
      }

      const fresh = (yield* get) ?? observed;
      return toAttrs(resourceGroup, bot, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const get = getConnection(
        subscriptionId,
        output.resourceGroup,
        output.bot,
        output.connectionName,
      );
      const deleteOnce = botservice
        .DeleteBotConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceName: output.bot,
          connectionName: output.connectionName,
        })
        .pipe(
          Effect.catchTag(
            [
              ...NOT_FOUND_TAGS,
              "MissingRegistration",
              "BotConnectionNotFound",
              "BotConnectionDeleteInProgress",
            ],
            () => Effect.void,
          ),
        );
      // Reads flap between present and missing for a while after a delete,
      // so delete while present and require several consecutive misses.
      const absent = get.pipe(
        Effect.flatMap((value) =>
          value === undefined ? Effect.void : Effect.fail("present" as const),
        ),
      );
      yield* Effect.gen(function* () {
        if ((yield* get) !== undefined) yield* deleteOnce;
        yield* absent.pipe(
          Effect.repeat({ schedule: Schedule.spaced("3 seconds"), times: 3 }),
        );
      }).pipe(
        Effect.retry({
          while: (e) => e === "present",
          schedule: Schedule.spaced("3 seconds"),
          times: 20,
        }),
        Effect.catchIf(
          (e): e is "present" => e === "present",
          () =>
            Effect.fail(
              new DeleteTimedOut({
                resource: `bot connection ${output.bot}/${output.connectionName}`,
                message: `bot connection ${output.connectionName} still exists after 20 delete attempts`,
              }),
            ),
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.BotService.Bot", "Azure.Resources.ResourceGroup"],
    },
  });
