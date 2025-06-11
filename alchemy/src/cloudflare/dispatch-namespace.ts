import type { Context } from "../context.ts";
import { Resource, ResourceKind } from "../resource.ts";
import { bind } from "../runtime/bind.ts";
import { logger } from "../util/logger.ts";
import { handleApiError } from "./api-error.ts";
import {
  createCloudflareApi,
  type CloudflareApi,
  type CloudflareApiOptions,
} from "./api.ts";
import type { Bound } from "./bound.ts";

/**
 * Properties for creating or updating a Dispatch Namespace
 */
export interface DispatchNamespaceProps extends CloudflareApiOptions {
  /**
   * Name of the namespace
   */
  namespace?: string;

  /**
   * Whether to adopt an existing namespace with the same name if it exists
   * If true and a namespace with the same name exists, it will be adopted rather than creating a new one
   *
   * @default false
   */
  adopt?: boolean;

  /**
   * Whether to delete the namespace.
   * If set to false, the namespace will remain but the resource will be removed from state
   *
   * @default true
   */
  delete?: boolean;
}

export function isDispatchNamespace(
  resource: Resource,
): resource is DispatchNamespaceResource {
  return resource[ResourceKind] === "cloudflare::DispatchNamespace";
}

/**
 * Output returned after Dispatch Namespace creation/update
 */
export interface DispatchNamespaceResource
  extends Resource<"cloudflare::DispatchNamespace">,
    Omit<DispatchNamespaceProps, "delete"> {
  type: "dispatch_namespace";
  /**
   * The name of the namespace
   */
  namespace: string;

  /**
   * Time at which the namespace was created
   */
  createdAt: number;

  /**
   * Time at which the namespace was last modified
   */
  modifiedAt: number;
}

export type DispatchNamespace = DispatchNamespaceResource &
  Bound<DispatchNamespaceResource>;

/**
 * A Cloudflare Dispatch Namespace enables routing worker requests to different scripts based on patterns.
 *
 * @see https://developers.cloudflare.com/workers/configuration/routing/dispatch-namespace/
 *
 * @example
 * // Create a basic dispatch namespace
 * const myNamespace = await DispatchNamespace("my-namespace", {
 *   namespace: "my-namespace"
 * });
 *
 * @example
 * // Create dispatch namespace with default name from id
 * const dispatchNS = await DispatchNamespace("api-dispatch");
 *
 * @example
 * // Adopt an existing namespace if it already exists instead of failing
 * const existingNamespace = await DispatchNamespace("existing-ns", {
 *   namespace: "existing-namespace",
 *   adopt: true
 * });
 *
 * @example
 * // When removing from Alchemy state, keep the namespace in Cloudflare
 * const preservedNamespace = await DispatchNamespace("preserve-ns", {
 *   namespace: "preserved-namespace",
 *   delete: false
 * });
 */

export async function DispatchNamespace(
  name: string,
  props: DispatchNamespaceProps = {},
): Promise<DispatchNamespace> {
  const dispatchNamespace = await _DispatchNamespace(name, props);
  const binding = await bind(dispatchNamespace);
  return {
    ...dispatchNamespace,
    // Add any runtime methods that dispatch namespaces might have
    // For now, this is mostly for type compatibility
    ...binding,
  };
}

const _DispatchNamespace = Resource(
  "cloudflare::DispatchNamespace",
  async function (
    this: Context<DispatchNamespaceResource>,
    id: string,
    props: DispatchNamespaceProps,
  ): Promise<DispatchNamespaceResource> {
    // Create Cloudflare API client with automatic account discovery
    const api = await createCloudflareApi(props);

    const namespace = props.namespace ?? id;

    if (this.phase === "delete") {
      // For delete operations, we need to check if the namespace exists in the output
      const namespaceName = this.output?.namespace;
      if (namespaceName && props.delete !== false) {
        await deleteDispatchNamespace(api, namespaceName);
      }

      // Return minimal output for deleted state
      return this.destroy();
    }

    // For create or update operations
    let createdAt =
      this.phase === "update"
        ? this.output?.createdAt || Date.now()
        : Date.now();

    if (this.phase === "update") {
      // For updates, we can't really change the namespace name, so just refresh metadata
    } else {
      try {
        // Try to create the dispatch namespace
        await createDispatchNamespace(api, {
          ...props,
          namespace,
        });
        createdAt = Date.now();
      } catch (error) {
        // Check if this is a "namespace already exists" error and adopt is enabled
        if (
          props.adopt &&
          error instanceof Error &&
          error.message.includes("already exists")
        ) {
          logger.log(
            `Dispatch namespace '${namespace}' already exists, adopting it`,
          );
          // For dispatch namespaces, if it exists and we're adopting, that's fine
          // We don't need to find it since the name is what we use for identification
        } else {
          // Re-throw the error if adopt is false or it's not a "namespace already exists" error
          throw error;
        }
      }
    }

    return this({
      type: "dispatch_namespace",
      namespace,
      createdAt: createdAt,
      modifiedAt: Date.now(),
    });
  },
);

export async function createDispatchNamespace(
  api: CloudflareApi,
  props: DispatchNamespaceProps & {
    namespace: string;
  },
): Promise<void> {
  const createResponse = await api.post(
    `/accounts/${api.accountId}/workers/dispatch/namespaces`,
    {
      namespace: props.namespace,
    },
  );

  if (!createResponse.ok) {
    await handleApiError(
      createResponse,
      "create",
      "dispatch_namespace",
      props.namespace,
    );
  }
}

export async function deleteDispatchNamespace(
  api: CloudflareApi,
  namespace: string,
) {
  // Delete dispatch namespace
  const deleteResponse = await api.delete(
    `/accounts/${api.accountId}/workers/dispatch/namespaces/${namespace}`,
  );

  if (!deleteResponse.ok && deleteResponse.status !== 404) {
    await handleApiError(
      deleteResponse,
      "delete",
      "dispatch_namespace",
      namespace,
    );
  }
}
