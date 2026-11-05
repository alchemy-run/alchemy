import * as transfer from "@distilled.cloud/aws/transfer";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTransferServerHttpBinding } from "./BindingHttp.ts";
import type { Server } from "./Server.ts";

/**
 * Runtime binding for `transfer:TestIdentityProvider`.
 *
 * Exercises the bound {@link Server}'s custom identity provider
 * (`API_GATEWAY`, `AWS_LAMBDA`, or `AWS_DIRECTORY_SERVICE`) with a user
 * name and optional password, returning the provider's raw response and
 * status code — the `ServerId` is injected from the binding. The password
 * is `Redacted` end-to-end (distilled marks `UserPassword` sensitive).
 * Calling it on a `SERVICE_MANAGED` server fails with the typed
 * `InvalidRequestException`. Provide the implementation with
 * `Effect.provide(AWS.Transfer.TestIdentityProviderHttp)`.
 * ### Diagnosing Authentication
 * **Example:** Test a User's Credentials
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * // init — bind the operation to the server
 * const testIdentityProvider = yield* AWS.Transfer.TestIdentityProvider(server);
 *
 * // runtime
 * const result = yield* testIdentityProvider({
 *   UserName: "alice",
 *   UserPassword: Redacted.make("secret"),
 *   ServerProtocol: "SFTP",
 * });
 * yield* Effect.log(`identity provider replied ${result.StatusCode}`);
 * ```
 *
 * @binding
 */
export interface TestIdentityProvider extends Binding.Service<
  TestIdentityProvider,
  "AWS.Transfer.TestIdentityProvider",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request: Omit<transfer.TestIdentityProviderRequest, "ServerId">,
    ) => Effect.Effect<transfer.TestIdentityProviderResponse, transfer.TestIdentityProviderError>
  >
> {}
export const TestIdentityProvider = Binding.Service<TestIdentityProvider>(
  "AWS.Transfer.TestIdentityProvider",
);

export const TestIdentityProviderHttp = Layer.effect(
  TestIdentityProvider,
  makeTransferServerHttpBinding({
    tag: "AWS.Transfer.TestIdentityProvider",
    operation: transfer.testIdentityProvider,
    actions: ["transfer:TestIdentityProvider"],
    // AWS authorizes this operation against the addressed user, despite the
    // binding being server-scoped so it can inject ServerId. UserName arrives
    // at runtime, so grant the operation on every user of the bound server.
    resource: (server) => Output.map(server.arn, (arn) => `${arn.replace(":server/", ":user/")}/*`),
  }),
);
