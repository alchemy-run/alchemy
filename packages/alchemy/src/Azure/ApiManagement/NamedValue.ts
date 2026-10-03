import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName, isParentOwned, sameName } from "./Common.ts";

export interface NamedValueKeyVault {
  /**
   * Key Vault secret identifier, e.g.
   * `https://{vault}.vault.azure.net/secrets/{name}`. Omit the version to
   * follow the latest version automatically.
   */
  secretIdentifier: string;
  /**
   * Client ID of the user-assigned identity used to read the secret.
   * @default the service's system-assigned identity
   */
  identityClientId?: string;
}

export interface NamedValueProps {
  /** Resource group of the API Management service. Changing it replaces the named value. */
  resourceGroup: string;
  /** API Management service that holds the named value. Changing it replaces the named value. */
  serviceName: string;
  /**
   * Named value identifier (1-256 characters). If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces
   * the named value.
   */
  name?: string;
  /**
   * Name used to reference the value in policies as `{{displayName}}`:
   * letters, digits, `-`, `.`, and `_`.
   * @default the named value identifier
   */
  displayName?: string;
  /**
   * Literal value. Exactly one of `value` and `keyVault` must be set.
   */
  value?: string | Redacted.Redacted<string>;
  /**
   * Store the value encrypted and hide it in the portal and API responses.
   * @default false (always `true` for Key Vault references)
   */
  secret?: boolean;
  /** Key Vault reference; the service identity needs `get` access to the secret. */
  keyVault?: NamedValueKeyVault;
  /** APIM labels used to filter named values (not ARM tags). */
  tags?: string[];
}

export interface NamedValue extends Resource<
  "Azure.ApiManagement.NamedValue",
  NamedValueProps,
  {
    /** Named value identifier. */
    namedValueName: string;
    /** ARM resource ID of the named value. */
    namedValueId: string;
    /** API Management service that holds the named value. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Name used in policies as `{{displayName}}`. */
    displayName: string;
    /** Whether the value is stored as a secret. */
    secret: boolean;
    /** APIM labels. */
    tags: string[];
  },
  never,
  Providers
> {}

/**
 * An API Management named value — a constant or secret that policies
 * reference as `{{displayName}}`. The value can be a literal or a Key
 * Vault secret reference.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-properties
 *
 * ### Creating a Named Value
 * **Example:** Plain value
 * ```typescript
 * const region = yield* Azure.ApiManagement.NamedValue("region", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   displayName: "region",
 *   value: "eu-west",
 * });
 * ```
 *
 * **Example:** Secret value
 * ```typescript
 * const apiKey = yield* Azure.ApiManagement.NamedValue("backend-key", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   displayName: "backend-key",
 *   value: Redacted.make(process.env.BACKEND_KEY!),
 *   secret: true,
 * });
 * ```
 *
 * ### Key Vault References
 * **Example:** Value read from Key Vault
 * ```typescript
 * const secret = yield* Azure.ApiManagement.NamedValue("db-password", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   keyVault: {
 *     secretIdentifier: "https://my-vault.vault.azure.net/secrets/db-password",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const NamedValue = Resource<NamedValue>(
  "Azure.ApiManagement.NamedValue",
);

const getNamedValue = (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
  namedValueId: string,
) =>
  orUndefinedIfNotFound(
    apim.GetNamedValue({
      subscriptionId,
      resourceGroupName,
      serviceName,
      namedValueId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serviceName: string,
  name: string,
  namedValue: apim.GetNamedValueResponse,
): NamedValue["Attributes"] => ({
  namedValueName: name,
  namedValueId: namedValue.id ?? "",
  serviceName,
  resourceGroup,
  displayName: namedValue.properties?.displayName ?? name,
  secret: namedValue.properties?.secret ?? false,
  tags: [...(namedValue.properties?.tags ?? [])],
});

const sameList = (a: readonly string[], b: readonly string[]) =>
  [...a].sort().join("\n") === [...b].sort().join("\n");

export const NamedValueProvider = () =>
  Provider.succeed(NamedValue, {
    stables: ["namedValueName", "namedValueId", "serviceName", "resourceGroup"],

    // Named values live inside a service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.serviceName, output.serviceName) ||
        (news.name !== undefined && !sameName(news.name, output.namedValueName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serviceName = output?.serviceName ?? olds?.serviceName;
      if (resourceGroup === undefined || serviceName === undefined) {
        return undefined;
      }
      const name =
        output?.namedValueName ?? olds?.name ?? (yield* createEntityName(id));
      const observed = yield* getNamedValue(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serviceName, name, observed);
      return (yield* isParentOwned(subscriptionId, resourceGroup, serviceName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const { resourceGroup, serviceName } = news;
      const name =
        news.name ?? output?.namedValueName ?? (yield* createEntityName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        serviceName,
        namedValueId: name,
      };
      const value =
        news.value === undefined
          ? undefined
          : typeof news.value === "string"
            ? news.value
            : Redacted.value(news.value);
      const secret =
        news.keyVault !== undefined ? true : (news.secret ?? false);
      const desired: apim.NamedValueCreateContractProperties = {
        displayName: news.displayName ?? name,
        value: news.keyVault !== undefined ? undefined : value,
        secret,
        keyVault: news.keyVault,
        tags: news.tags ?? [],
      };
      const get = getNamedValue(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );

      // Observe. Secret values are not returned by GET; read them through
      // listValue to compare against the desired value.
      const observed = yield* get;
      let inSync = false;
      if (observed?.properties !== undefined) {
        const props = observed.properties;
        const observedValue =
          desired.value !== undefined && props.secret
            ? (yield* apim.ListNamedValueValue(where)).value
            : props.value;
        inSync =
          props.displayName === desired.displayName &&
          (props.secret ?? false) === secret &&
          sameList(props.tags ?? [], desired.tags ?? []) &&
          (desired.keyVault === undefined
            ? observedValue === desired.value
            : props.keyVault?.secretIdentifier ===
                desired.keyVault.secretIdentifier &&
              props.keyVault?.identityClientId ===
                desired.keyVault.identityClientId);
      }

      // Ensure + sync with one upsert. Key Vault references resolve
      // asynchronously (202), so wait for the entity to settle.
      if (!inSync) {
        yield* apim.NamedValueCreateOrUpdate({ ...where, properties: desired });
      }
      const current = yield* waitForProvisioned(
        `API Management named value ${name}`,
        get,
        (namedValue) => namedValue.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, serviceName, name, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        apim.DeleteNamedValue({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serviceName: output.serviceName,
          namedValueId: output.namedValueName,
        }),
      );
      yield* waitUntilGone(
        `API Management named value ${output.namedValueName}`,
        getNamedValue(
          subscriptionId,
          output.resourceGroup,
          output.serviceName,
          output.namedValueName,
        ),
        { interval: "2 seconds", times: 15 },
      );
    }),
  });
