import * as containerregistry from "@distilled.cloud/azure/containerregistry";
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
import {
  createRegistryName,
  registryOwnedByStage,
  sameName,
} from "./Common.ts";

export type TokenPasswordName = "password1" | "password2";

export interface TokenPasswordSpec {
  /** Password slot. */
  name: TokenPasswordName;
  /**
   * Expiry (ISO 8601). Changing it regenerates the password.
   * @default never expires
   */
  expiry?: string;
}

export interface TokenProps {
  /** Resource group of the registry. Changing it replaces the token. */
  resourceGroup: string;
  /** Registry that holds the token. Changing it replaces the token. */
  registry: string;
  /**
   * Token name (also the username for `docker login`): 5-50 letters,
   * digits, hyphens, and underscores. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * token.
   */
  name?: string;
  /** ARM resource ID of the `ScopeMap` that grants the token's permissions. */
  scopeMapId: string;
  /**
   * Whether the token can authenticate.
   * @default "enabled"
   */
  status?: "enabled" | "disabled";
  /**
   * Passwords to generate. A password value is only returned when it is
   * generated, so Alchemy generates each missing slot once and keeps its
   * value in state. Removing a slot revokes that password.
   * @default no passwords
   */
  passwords?: TokenPasswordSpec[];
}

export interface TokenPasswordValue {
  /** Password slot. */
  name: string;
  /** Password value (only known for passwords Alchemy generated). */
  value: Redacted.Redacted<string> | undefined;
  /** Expiry (ISO 8601), if any. */
  expiry: string | undefined;
}

export interface Token extends Resource<
  "Azure.ContainerRegistry.Token",
  TokenProps,
  {
    /** Name of the token (the `docker login` username). */
    tokenName: string;
    /** ARM resource ID of the token. */
    tokenId: string;
    /** Registry that holds the token. */
    registry: string;
    /** Resource group of the registry. */
    resourceGroup: string;
    /** ARM resource ID of the bound scope map. */
    scopeMapId: string;
    /** Whether the token is `enabled` or `disabled`. */
    status: string;
    /** Generated passwords. */
    passwords: TokenPasswordValue[];
    /** Creation date (ISO 8601). */
    creationDate: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A repository-scoped access token for a container registry. The token
 * name is the username; its permissions come from a `ScopeMap`.
 *
 * Tokens have no tags; Alchemy treats one as owned when its registry
 * carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/container-registry/container-registry-repository-scoped-permissions
 *
 * ### Creating a Token
 * **Example:** Pull-only token with a generated password
 * ```typescript
 * const pull = yield* Azure.ContainerRegistry.ScopeMap("app-pull", {
 *   resourceGroup: group.resourceGroupName,
 *   registry: registry.registryName,
 *   actions: ["repositories/app/content/read"],
 * });
 * const token = yield* Azure.ContainerRegistry.Token("ci", {
 *   resourceGroup: group.resourceGroupName,
 *   registry: registry.registryName,
 *   scopeMapId: pull.scopeMapId,
 *   passwords: [{ name: "password1" }],
 * });
 * // docker login <loginServer> -u token.tokenName -p token.passwords[0].value
 * ```
 *
 * **Example:** Disabled token
 * ```typescript
 * const token = yield* Azure.ContainerRegistry.Token("ci", {
 *   resourceGroup: group.resourceGroupName,
 *   registry: registry.registryName,
 *   scopeMapId: pull.scopeMapId,
 *   status: "disabled",
 * });
 * ```
 *
 * @resource
 */
export const Token = Resource<Token>("Azure.ContainerRegistry.Token");

const getToken = (
  subscriptionId: string,
  resourceGroupName: string,
  registryName: string,
  tokenName: string,
) =>
  orUndefinedIfNotFound(
    containerregistry.GetToken({
      subscriptionId,
      resourceGroupName,
      registryName,
      tokenName,
    }),
  );

const sameInstant = (a: string | undefined, b: string | undefined) =>
  a === undefined || b === undefined
    ? a === b
    : Date.parse(a) === Date.parse(b);

const toAttrs = (
  resourceGroup: string,
  registry: string,
  name: string,
  token: containerregistry.GetTokenResponse,
  values: ReadonlyMap<string, Redacted.Redacted<string> | undefined>,
): Token["Attributes"] => ({
  tokenName: name,
  tokenId: token.id ?? "",
  registry,
  resourceGroup,
  scopeMapId: token.properties?.scopeMapId ?? "",
  status: token.properties?.status ?? "enabled",
  passwords: (token.properties?.credentials?.passwords ?? []).flatMap((p) =>
    p.name === undefined
      ? []
      : [{ name: p.name, value: values.get(p.name), expiry: p.expiry }],
  ),
  creationDate: token.properties?.creationDate,
});

export const TokenProvider = () =>
  Provider.succeed(Token, {
    stables: ["tokenName", "tokenId", "registry", "resourceGroup"],

    // Tokens live inside a registry; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.registry, output.registry) ||
        (news.name !== undefined && !sameName(news.name, output.tokenName))
      ) {
        // A kept explicit name must be freed before it can be reused.
        return {
          action: "replace",
          deleteFirst:
            news.name !== undefined && sameName(news.name, output.tokenName),
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const registry = output?.registry ?? olds?.registry;
      if (resourceGroup === undefined || registry === undefined) {
        return undefined;
      }
      const name =
        output?.tokenName ?? olds?.name ?? (yield* createRegistryName(id));
      const observed = yield* getToken(
        subscriptionId,
        resourceGroup,
        registry,
        name,
      );
      if (observed === undefined) return undefined;
      const values = new Map(
        (output?.passwords ?? []).map((p) => [p.name, p.value] as const),
      );
      const attrs = toAttrs(resourceGroup, registry, name, observed, values);
      return (yield* registryOwnedByStage(
        subscriptionId,
        resourceGroup,
        registry,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerRegistry");
      const { resourceGroup, registry } = news;
      const name =
        news.name ?? output?.tokenName ?? (yield* createRegistryName(id));
      const status = news.status ?? "enabled";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        registryName: registry,
        tokenName: name,
      };
      const get = getToken(subscriptionId, resourceGroup, registry, name);
      const waitReady = waitForProvisioned(
        `token ${name}`,
        get,
        (token) => token.properties?.provisioningState,
        { interval: "2 seconds", times: 30 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* containerregistry.CreateToken({
          ...where,
          properties: { scopeMapId: news.scopeMapId, status },
        });
      }
      observed = yield* waitReady;

      // Sync scope map and status.
      const scopeMapChanged = !sameName(
        observed.properties?.scopeMapId,
        news.scopeMapId,
      );
      const statusChanged =
        (observed.properties?.status ?? "enabled") !== status;

      // Sync passwords: revoke slots no longer desired.
      const desired = news.passwords ?? [];
      const observedPasswords =
        observed.properties?.credentials?.passwords ?? [];
      const kept = observedPasswords.filter((p) =>
        desired.some((d) => d.name === p.name),
      );
      const revoke = kept.length !== observedPasswords.length;

      if (scopeMapChanged || statusChanged || revoke) {
        yield* containerregistry.UpdateToken({
          ...where,
          properties: {
            scopeMapId: scopeMapChanged ? news.scopeMapId : undefined,
            status: statusChanged ? status : undefined,
            credentials: revoke
              ? {
                  passwords: kept.map((p) => ({
                    name: p.name,
                    expiry: p.expiry,
                    creationTime: p.creationTime,
                  })),
                }
              : undefined,
          },
        });
        observed = yield* waitReady;
      }

      // Generate each missing (or re-expired) slot once; carry known values.
      const values = new Map<string, Redacted.Redacted<string> | undefined>(
        (output?.passwords ?? []).map((p) => [p.name, p.value] as const),
      );
      let generated = false;
      for (const spec of desired) {
        const current = (
          observed.properties?.credentials?.passwords ?? []
        ).find((p) => p.name === spec.name);
        if (
          current !== undefined &&
          values.get(spec.name) !== undefined &&
          (spec.expiry === undefined ||
            sameInstant(spec.expiry, current.expiry))
        ) {
          continue;
        }
        const result = yield* containerregistry.GenerateRegistryCredentials({
          subscriptionId,
          resourceGroupName: resourceGroup,
          registryName: registry,
          tokenId: observed.id,
          name: spec.name,
          expiry: spec.expiry,
        });
        const value = result.passwords?.find(
          (p) => p.name === spec.name,
        )?.value;
        values.set(
          spec.name,
          value === undefined ? undefined : Redacted.make(value),
        );
        generated = true;
      }
      if (generated) observed = yield* waitReady;

      return toAttrs(resourceGroup, registry, name, observed, values);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        containerregistry.DeleteToken({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          registryName: output.registry,
          tokenName: output.tokenName,
        }),
      );
      yield* waitUntilGone(
        `token ${output.tokenName}`,
        getToken(
          subscriptionId,
          output.resourceGroup,
          output.registry,
          output.tokenName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ContainerRegistry.Registry",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
