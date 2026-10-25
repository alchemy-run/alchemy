import { fromStaticToken } from "@distilled.cloud/azure";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { ChatRequest } from "./ChatTypes.ts";
import type { CommunicationService } from "./CommunicationService.ts";

/**
 * Shared scaffolding for the Azure Communication Services data-plane
 * bindings: resolves the distilled operation once when the layer is built,
 * injects the bound service's `endpoint`, and assigns the binding's role on
 * that service at deploy time.
 *
 * NOT exported from `index.ts`.
 */

/**
 * Azure RBAC actions the Communication Services data plane checks for
 * Microsoft Entra callers. The resource provider has no data actions; the
 * data plane answers 401 `Denied` without them (live-verified: Email and
 * Rooms need both `Read` and `Write`, reads included; Identity needs only
 * `Write`).
 */
export const CommunicationAction = {
  read: "Microsoft.Communication/CommunicationServices/Read",
  write: "Microsoft.Communication/CommunicationServices/Write",
} as const;

/**
 * A custom role (`Azure.Authorization.RoleDefinition`, defined once per
 * stack at the subscription and assigned only on the bound communication
 * service) with exactly `actions`. Bindings with the same actions share one
 * role, so a host that binds several gets one assignment.
 */
export interface CommunicationGrant {
  readonly role: string;
  readonly actions: readonly string[];
}

/**
 * The custom roles the Entra bindings assign; the logical ID is
 * `AzureCommunication<role>Role`. Both are narrower than the built-in
 * **Communication and Email Service Owner** or **Contributor**: they cannot
 * read keys, delete the service, or touch other resources.
 */
export const CommunicationRole = {
  /** Email, SMS, and Rooms. */
  Data: {
    role: "Data",
    actions: [CommunicationAction.read, CommunicationAction.write],
  },
  /** Identity: users, tokens, and Teams interoperability. */
  Identity: { role: "Identity", actions: [CommunicationAction.write] },
} as const satisfies Record<string, CommunicationGrant>;

/** Assign `grant` on the communication service to the host, creating its custom role. */
const GrantOnCommunicationService = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (
    tag: string,
    service: CommunicationService,
    grant: CommunicationGrant,
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const role = yield* AzureRoleDefinition(`AzureCommunication${grant.role}Role`, {
        description: `Alchemy Communication Services binding: ${grant.actions.join(", ")}`,
        permissions: [{ actions: [...grant.actions] }],
      });
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [
        { roleDefinitionId: role.roleDefinitionId, scope: service.communicationServiceId },
      ];
      yield* bind`${tag}(${service})`({ roleAssignments });
    }
  });
});

/** `https://{host}` of the service, resolved per call at runtime. */
const endpointOf = (service: CommunicationService) =>
  service.endpoint.pipe(Output.map((endpoint) => endpoint ?? ""));

/** A distilled operation, resolved with the host's credentials. */
type Operation<I, A, E> = (input: I) => Effect.Effect<A, E>;

/**
 * Build the impl Effect for an Entra-authorized operation whose request
 * carries `endpoint` (Email, SMS, Identity, Rooms): the runtime callable
 * injects the bound {@link CommunicationService}'s endpoint, and the
 * deploy-time half assigns `grant` on the service.
 */
export const makeCommunicationHttpBinding = <I extends { endpoint: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Communication.SendEmail`. */
  tag: string;
  /** The distilled operation; the endpoint is injected. */
  operation: Effect.Effect<Operation<I, A, E>, never, any>;
  /** Role assigned on the communication service. */
  grant: CommunicationGrant;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantOnCommunicationService;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (service: CommunicationService) {
      yield* grant(options.tag, service, options.grant);
      const endpoint = yield* endpointOf(service);
      return Effect.fn(`${options.tag}(${service.LogicalId})`)(function* (
        request?: Omit<I, "endpoint">,
      ) {
        const url = yield* endpoint;
        // `Omit<I, "endpoint"> & { endpoint }` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, endpoint: url } as I);
      });
    });
  });

/**
 * Build the impl Effect for a Chat operation. Chat authorizes with a
 * Communication Services user access token, not Azure RBAC, so the binding
 * assigns no role: the runtime callable injects the bound service's
 * endpoint and sends the request's `userAccessToken` as the bearer token.
 */
export const makeChatHttpBinding = <I extends { endpoint: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Communication.SendChatMessage`. */
  tag: string;
  /** The distilled `communication-chat` operation; the endpoint is injected. */
  operation: (input: I) => Effect.Effect<A, E, any>;
}) =>
  Effect.gen(function* () {
    return Effect.fn(function* (service: CommunicationService) {
      const endpoint = yield* endpointOf(service);
      return Effect.fn(`${options.tag}(${service.LogicalId})`)(function* (request: ChatRequest<I>) {
        const url = yield* endpoint;
        const { userAccessToken, ...rest } = request;
        const credentials = fromStaticToken({
          bearerToken: Redacted.isRedacted(userAccessToken)
            ? userAccessToken
            : Redacted.make(userAccessToken),
          // Data-plane operations take no subscription.
          subscriptionId: "",
        });
        // Provided around the call, so the user's token wins over any
        // Azure credentials already in the caller's context. `Omit<I,
        // "endpoint"> & { endpoint }` is `I`, but TypeScript cannot prove it
        // for a generic `I`.
        const call = options
          .operation({ ...rest, endpoint: url } as unknown as I)
          .pipe(Effect.provide(Layer.mergeAll(credentials, FetchHttpClient.layer)));
        // `any` in the operation's requirements is the generated
        // `AzureOpContext`, which the layer above satisfies.
        return yield* call as Effect.Effect<A, E>;
      });
    });
  });
