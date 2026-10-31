import * as Rivet from "@distilled.cloud/rivet";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClientError from "effect/http/HttpClientError";
import { withConnection, type ConnectionProps } from "./internal/Connection.ts";

export interface NamespaceProps extends ConnectionProps {
  /**
   * Namespace name: a DNS label of 1 to 63 lowercase letters, digits and
   * hyphens. Immutable; changing it replaces the namespace.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
}

export interface Namespace extends Resource<
  "Rivet.Namespace",
  NamespaceProps,
  {
    /** The namespace name. */
    name: string;
    /** The control plane the namespace lives on. */
    endpoint: string;
    /** When the namespace was created, in Unix milliseconds. */
    createdAt: number;
  }
> {}

/**
 * A namespace on a Rivet control plane: an isolated set of node pools and
 * actors. Each stage of an app usually gets its own.
 *
 * Rivet has no API to delete a namespace, so destroying the resource leaves
 * the namespace in place (empty once its pools are gone) and stops managing
 * it.
 *
 * ### Creating a namespace
 * **Example:** A namespace for this stage
 * ```typescript
 * const namespace = yield* Rivet.Namespace("App", {
 *   endpoint: "https://rivet.example.com",
 *   token: Redacted.make(adminToken),
 * });
 * ```
 *
 * @resource
 */
export const Namespace = Resource<Namespace>("Rivet.Namespace");

/** A namespace create returned success but the namespace cannot be read back. */
export class NamespaceVanished extends Data.TaggedError("Rivet.NamespaceVanished")<{
  readonly message: string;
}> {}

const namespaceName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, lowercase: true, maxLength: 63, delimiter: "-" });

export const NamespaceProvider = () =>
  Provider.effect(
    Namespace,
    Effect.gen(function* () {
      const observe = (connection: ConnectionProps, name: string, wait?: Duration.Input) =>
        Rivet.namespaces.listNamespaces({ name }).pipe(
          Effect.map((res) => res.namespaces.find((ns) => ns.name === name)),
          withConnection(connection, wait === undefined ? {} : { wait }),
        );

      const toAttrs = (connection: ConnectionProps, ns: Rivet.namespaces.Namespace) => ({
        name: ns.name,
        endpoint: connection.endpoint,
        createdAt: ns.create_ts,
      });

      return {
        stables: ["name", "endpoint", "createdAt"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const name = output?.name ?? (yield* namespaceName(id, olds?.name));
          if ((yield* namespaceName(id, news.name)) !== name) {
            return { action: "replace" } as const;
          }
          if (news.endpoint !== (output?.endpoint ?? olds?.endpoint)) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* namespaceName(id, olds?.name));
          // A control plane that never came up (or is gone) has no namespace
          // to find, and deleting one is a no-op: let it go with its stack
          // after a short wait rather than the full startup budget.
          const ns = yield* observe(olds, name, "30 seconds").pipe(
            Effect.catchTag(
              ["BadGateway", "ServiceUnavailable", "GatewayTimeout", "TimeoutError"],
              () => Effect.undefined,
            ),
            Effect.catchIf(
              (error) =>
                HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError",
              () => Effect.undefined,
            ),
          );
          if (ns === undefined) return undefined;
          const attrs = toAttrs(olds, ns);
          // Namespaces carry no tags: one found under a user-chosen name with
          // no prior state may belong to someone else.
          return output !== undefined || olds.name === undefined ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* namespaceName(id, news.name));
          // Observe
          let ns = yield* observe(news, name);
          // Ensure
          if (ns === undefined) {
            yield* session.note(`Creating namespace ${name}...`);
            ns = yield* Rivet.namespaces.createNamespace({ name }).pipe(
              Effect.map((res) => res.namespace),
              Effect.catchTag("NamespaceAlreadyExists", () => observe(news, name)),
              withConnection(news),
            );
          }
          if (ns === undefined) {
            return yield* new NamespaceVanished({
              message: `Rivet namespace ${name} vanished after create`,
            });
          }
          return toAttrs(news, ns);
        }),
        // Rivet has no delete API for namespaces: the namespace is retained.
        delete: () => Effect.void,
      };
    }),
  );
