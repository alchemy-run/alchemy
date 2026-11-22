import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export type UserState = "active" | "blocked" | "pending" | "deleted";

export interface UserProps {
  /** Resource group of the API Management service. Changing it replaces the user. */
  resourceGroup: string;
  /** API Management service that holds the user. Changing it replaces the user. */
  serviceName: string;
  /**
   * User identifier, unique within the service. Changing it replaces the user.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /** Email address, unique within the service. */
  email: string;
  /** First name. */
  firstName: string;
  /** Last name. */
  lastName: string;
  /**
   * Account state. `blocked` users cannot sign in to the developer portal
   * or call APIs with their subscriptions.
   * @default "active"
   */
  state?: UserState;
  /**
   * Optional note about the user set by an administrator.
   * @default no note
   */
  note?: string;
  /**
   * Sign-in password. Only sent when the user is created or updated.
   * @default no password
   */
  password?: Redacted.Redacted<string>;
  /**
   * External identities of the user, e.g. `{ provider: "aad", id: objectId }`.
   * @default none
   */
  identities?: apim.UserIdentityContract[];
  /**
   * Whether a confirmation email is sent on creation (`signup`) or an invitation (`invite`).
   * @default not set (Azure's default applies)
   */
  confirmation?: "signup" | "invite";
  /**
   * Developer portal the user belongs to.
   * @default "developerPortal"
   */
  appType?: "portal" | "developerPortal";
}

export interface User extends Resource<
  "Azure.ApiManagement.User",
  UserProps,
  {
    /** User identifier within the service. */
    userName: string;
    /** ARM resource ID of the user. */
    userId: string;
    /** API Management service that holds the user. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Email address of the user. */
    email: string;
    /** Account state of the user. */
    state: string;
  },
  never,
  Providers
> {}

/**
 * A developer account of an API Management service. Users hold
 * subscriptions and belong to groups. Not available on the Consumption
 * tier. Deleting the user also deletes its subscriptions.
 * The ARM type is `Microsoft.ApiManagement/service/users`.
 *
 * :::caution
 * Changing `serviceName`, `name`, or `resourceGroup` replaces the user.
 *
 * Users are not available on the Consumption tier ("Method not allowed in
 * Consumption pricing tier").
 * :::
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-create-or-invite-developers
 *
 * ### Creating Users
 * **Example:** A developer account
 * ```typescript
 * const apim = yield* Azure.ApiManagement.Service("gateway", {
 *   sku: { name: "BasicV2", capacity: 1 },
 *   publisherEmail: "ops@example.com",
 *   publisherName: "Example Inc",
 * });
 * const user = yield* Azure.ApiManagement.User("jane", {
 *   serviceName: apim.serviceName,
 *   email: "jane@example.com",
 *   firstName: "Jane",
 *   lastName: "Doe",
 * });
 * ```
 *
 * **Example:** Block a user
 * ```typescript
 * const apim = yield* Azure.ApiManagement.Service("gateway", {
 *   sku: { name: "BasicV2", capacity: 1 },
 *   publisherEmail: "ops@example.com",
 *   publisherName: "Example Inc",
 * });
 * yield* Azure.ApiManagement.User("jane", {
 *   serviceName: apim.serviceName,
 *   email: "jane@example.com",
 *   firstName: "Jane",
 *   lastName: "Doe",
 *   state: "blocked",
 *   note: "Exceeded fair use",
 * });
 * ```
 *
 * @resource
 */
export const User = GroupedResource<User>("Azure.ApiManagement.User");

interface Key {
  resourceGroup: string;
  serviceName: string;
  userName: string;
}

export const UserProvider = () =>
  Provider.succeed(User, {
    stables: ["userName", "userId", "serviceName", "resourceGroup"],
    ...entityLifecycle<UserProps, User["Attributes"], Key, apim.GetUserResponse>({
      label: (key) => `API Management user ${key.userName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            userName: props.name ?? output?.userName ?? (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetUser({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          userId: key.userName,
        }),
      put: (subscriptionId, key, news) =>
        apim.UserCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          userId: key.userName,
          properties: {
            email: news.email,
            firstName: news.firstName,
            lastName: news.lastName,
            state: news.state ?? "active",
            note: news.note,
            password: news.password,
            identities: news.identities,
            confirmation: news.confirmation,
            appType: news.appType ?? "developerPortal",
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteUser({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          userId: key.userName,
          deleteSubscriptions: true,
        }),
      inSync: (news, observed) => {
        const props = observed.properties;
        return (
          props?.email?.toLowerCase() === news.email.toLowerCase() &&
          props.firstName === news.firstName &&
          props.lastName === news.lastName &&
          props.state === (news.state ?? "active") &&
          (news.note === undefined || props.note === news.note)
        );
      },
      // The built-in administrator account is never ours.
      isSystem: (observed) => observed.name === "1",
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        userName: key.userName,
        userId: observed.id ?? "",
        email: observed.properties?.email ?? "",
        state: observed.properties?.state ?? "active",
      }),
    }),
  });
