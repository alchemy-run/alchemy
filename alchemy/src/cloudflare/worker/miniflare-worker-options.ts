import {
  kCurrentWorker,
  type RemoteProxyConnectionString,
  type WorkerOptions,
} from "miniflare";
import assert from "node:assert";
import { assertNever } from "../../util/assert-never.ts";
import { logger } from "../../util/logger.ts";
import { Self, type Binding, type WorkerBindingSpec } from "../bindings.ts";
import type { WorkerProps } from "../worker.ts";

export type MiniflareWorkerOptions = Pick<
  WorkerProps,
  | "bindings"
  | "eventSources"
  | "compatibilityDate"
  | "compatibilityFlags"
  | "format"
> & {
  name: string;
  script: string;
  port?: number;
};

type BindingType = Exclude<Binding, string | Self>["type"];

const REMOTE_ONLY_BINDING_TYPES = [
  "ai",
  "ai_gateway",
  "browser",
  "dispatch_namespace",
  "vectorize",
] satisfies BindingType[];
const REMOTE_OPTIONAL_BINDING_TYPES = [
  "d1",
  // "durable_object_namespace", This is supported in Miniflare but needs some wrangling to make it work with a remote proxy.
  "images",
  "kv_namespace",
  "r2_bucket",
  "queue",
  "service",
  // "workflow", same thing
] satisfies BindingType[];

type RemoteBindingType =
  | (typeof REMOTE_ONLY_BINDING_TYPES)[number]
  | (typeof REMOTE_OPTIONAL_BINDING_TYPES)[number];

type RemoteBinding = Extract<Binding, { type: RemoteBindingType }>;

export function buildRemoteBindings(
  input: Pick<MiniflareWorkerOptions, "bindings">,
) {
  const bindings: WorkerBindingSpec[] = [];
  for (const [name, binding] of Object.entries(input.bindings ?? {})) {
    if (isRemoteOnlyBinding(binding)) {
      bindings.push(buildRemoteBinding(name, binding));
    } else if (isRemoteOptionalBinding(binding) && isRemoteEnabled(binding)) {
      bindings.push(buildRemoteBinding(name, binding));
    }
  }
  return bindings;
}

function isRemoteOptionalBinding(binding: Binding): binding is RemoteBinding {
  return (
    typeof binding !== "string" &&
    binding !== Self &&
    typeof binding === "object" &&
    "type" in binding &&
    REMOTE_OPTIONAL_BINDING_TYPES.includes(binding.type as any)
  );
}

function isRemoteOnlyBinding(binding: Binding): binding is RemoteBinding {
  return (
    typeof binding !== "string" &&
    binding !== Self &&
    typeof binding === "object" &&
    "type" in binding &&
    REMOTE_ONLY_BINDING_TYPES.includes(binding.type as any)
  );
}

function isRemoteEnabled(binding: RemoteBinding): boolean {
  return (
    "dev" in binding &&
    typeof binding.dev === "object" &&
    "remote" in binding.dev &&
    !!binding.dev.remote
  );
}

function buildRemoteBinding(
  name: string,
  binding: RemoteBinding,
): WorkerBindingSpec & { raw?: true } {
  switch (binding.type) {
    case "ai": {
      return {
        type: "ai",
        name,
        raw: true,
      };
    }
    case "ai_gateway": {
      return {
        type: "ai",
        name,
        raw: true,
      };
    }
    case "browser": {
      return {
        type: "browser",
        name,
        raw: true,
      };
    }
    case "d1": {
      return {
        type: "d1",
        name,
        id: binding.id,
        raw: true,
      };
    }
    case "dispatch_namespace": {
      return {
        type: "dispatch_namespace",
        name,
        namespace: binding.namespace,
        raw: true,
      };
    }
    // case "durable_object_namespace": {
    //   return {
    //     type: "durable_object_namespace",
    //     name,
    //     class_name: binding.className,
    //     script_name: binding.scriptName,
    //     raw: true,
    //   };
    // }
    case "images": {
      return {
        type: "images",
        name,
        raw: true,
      };
    }
    case "kv_namespace": {
      return {
        type: "kv_namespace",
        name,
        namespace_id:
          "namespaceId" in binding ? binding.namespaceId : binding.id,
        raw: true,
      };
    }
    case "queue": {
      return {
        type: "queue",
        name,
        queue_name: binding.name,
        raw: true,
      };
    }
    case "r2_bucket": {
      return {
        type: "r2_bucket",
        name,
        bucket_name: binding.name,
        raw: true,
      };
    }
    case "service": {
      return {
        type: "service",
        name,
        service: "service" in binding ? binding.service : binding.name,
        environment: "environment" in binding ? binding.environment : undefined,
      };
    }
    case "vectorize": {
      return {
        type: "vectorize",
        name,
        index_name: binding.name,
        raw: true,
      };
    }
    // case "workflow": {
    //   return {
    //     type: "workflow",
    //     name,
    //     workflow_name: binding.workflowName,
    //     class_name: binding.className,
    //     script_name: binding.scriptName,
    //     raw: true,
    //   };
    // }
    default: {
      assertNever(binding);
    }
  }
}

export function buildMiniflareWorkerOptions({
  name: workerName,
  script,
  bindings,
  format,
  eventSources,
  compatibilityDate,
  compatibilityFlags,
  remoteProxyConnectionString,
}: MiniflareWorkerOptions & {
  remoteProxyConnectionString: RemoteProxyConnectionString | undefined;
}): WorkerOptions {
  const options: WorkerOptions = {
    name: workerName,
    script,
    modules: format !== "cjs",
    compatibilityDate,
    compatibilityFlags,
    unsafeDirectSockets: [{ entrypoint: undefined, proxy: true }],
    // containerEngine: {
    //   localDocker: {
    //     socketPath: "/var/run/docker.sock",
    //   }
    // }
  };
  for (const [name, binding] of Object.entries(bindings ?? {})) {
    if (typeof binding === "string") {
      options.bindings = {
        ...options.bindings,
        [name]: binding,
      };
      continue;
    }
    if (binding === Self) {
      options.serviceBindings = {
        ...((options.serviceBindings as Record<string, string> | undefined) ??
          {}),
        [name]: kCurrentWorker,
      };
      continue;
    }
    switch (binding.type) {
      case "ai": {
        assert(
          remoteProxyConnectionString,
          `Binding "${name}" of type "${binding.type}" requires a remoteProxyConnectionString, but none was provided.`,
        );
        options.ai = {
          binding: name,
          remoteProxyConnectionString,
        };
        break;
      }
      case "ai_gateway": {
        assert(
          remoteProxyConnectionString,
          `Binding "${name}" of type "${binding.type}" requires a remoteProxyConnectionString, but none was provided.`,
        );
        options.ai = {
          binding: name,
          remoteProxyConnectionString,
        };
        break;
      }
      case "analytics_engine": {
        (options.analyticsEngineDatasets ??= {})[name] = {
          dataset: binding.dataset,
        };
        break;
      }
      case "assets": {
        options.assets = {
          binding: name,
          directory: binding.path,
        };
        break;
      }
      case "browser": {
        assert(
          remoteProxyConnectionString,
          `Binding "${name}" of type "${binding.type}" requires a remoteProxyConnectionString, but none was provided.`,
        );
        options.browserRendering = {
          binding: name,
          remoteProxyConnectionString,
        };
        break;
      }
      case "d1": {
        (
          (options.d1Databases ??= {}) as Record<
            string,
            {
              id: string;
              remoteProxyConnectionString?: RemoteProxyConnectionString;
            }
          >
        )[name] = {
          id: binding.id,
          remoteProxyConnectionString: binding.dev?.remote
            ? remoteProxyConnectionString
            : undefined,
        };
        break;
      }
      case "dispatch_namespace": {
        assert(
          remoteProxyConnectionString,
          `Binding "${name}" of type "${binding.type}" requires a remoteProxyConnectionString, but none was provided.`,
        );
        (options.dispatchNamespaces ??= {})[name] = {
          namespace: binding.namespace,
          remoteProxyConnectionString,
        };
        break;
      }
      case "durable_object_namespace": {
        (options.durableObjects ??= {})[name] = {
          className: binding.className,
          scriptName: binding.scriptName,
          useSQLite: binding.sqlite,
          // namespaceId: binding.namespaceId,
          // unsafeUniqueKey?: string | typeof kUnsafeEphemeralUniqueKey | undefined;
          // unsafePreventEviction?: boolean | undefined;
          // remoteProxyConnectionString: binding.local
          //   ? undefined
          //   : remoteProxyConnectionString,
        };
        if (!binding.scriptName || binding.scriptName === workerName) {
          options.unsafeDirectSockets!.push({
            entrypoint: binding.className,
            proxy: true,
          });
        }
        break;
      }
      case "hyperdrive": {
        if ("access_client_id" in binding.origin) {
          throw new Error(
            `Hyperdrive with Cloudflare Access is not supported for locally emulated workers. Worker "${name}" is locally emulated but is bound to Hyperdrive "${name}", which has Cloudflare Access enabled.`,
          );
        }
        logger.warnOnce(
          `Hyperdrive bindings in locally emulated workers are experimental and may not work as expected. Worker "${name}" is locally emulated and bound to Hyperdrive "${name}".`,
        );
        const {
          scheme = "postgres",
          port = 5432,
          password,
          database,
          host,
          user,
        } = binding.origin;
        const connectionString = new URL(
          `${scheme}://${user}:${password.unencrypted}@${host}:${port}/${database}?sslmode=${binding.mtls?.sslmode ?? "verify-full"}`,
        );
        (options.bindings ??= {})[name] = {
          connectionString: connectionString.toString(),
          database,
          host,
          password: password.unencrypted,
          port,
          scheme,
          user,
        };
        break;
      }
      case "images": {
        options.images = {
          binding: name,
          remoteProxyConnectionString: binding.dev?.remote
            ? remoteProxyConnectionString
            : undefined,
        };
        break;
      }
      case "json": {
        (options.bindings ??= {})[name] = binding.json;
        break;
      }
      case "kv_namespace": {
        const normalized =
          "id" in binding
            ? { id: binding.id }
            : { id: binding.namespaceId, dev: binding.dev };
        (
          (options.kvNamespaces ??= {}) as Record<
            string,
            {
              id: string;
              remoteProxyConnectionString?: RemoteProxyConnectionString;
            }
          >
        )[name] = {
          id: normalized.id,
          remoteProxyConnectionString: normalized.dev?.remote
            ? remoteProxyConnectionString
            : undefined,
        };
        break;
      }
      case "pipeline": {
        ((options.pipelines ??= {}) as Record<string, string>)[name] =
          binding.id;
        break;
      }
      case "queue": {
        (
          (options.queueProducers ??= {}) as Record<
            string,
            {
              queueName: string;
              deliveryDelay?: number;
              remoteProxyConnectionString?: RemoteProxyConnectionString;
            }
          >
        )[name] = {
          queueName: binding.name,
          deliveryDelay: binding.settings?.deliveryDelay,
          remoteProxyConnectionString: binding.dev?.remote
            ? remoteProxyConnectionString
            : undefined,
        };
        break;
      }
      case "r2_bucket": {
        (
          (options.r2Buckets ??= {}) as Record<
            string,
            {
              id: string;
              remoteProxyConnectionString?: RemoteProxyConnectionString;
            }
          >
        )[name] = {
          id: binding.name,
          remoteProxyConnectionString: binding.dev?.remote
            ? remoteProxyConnectionString
            : undefined,
        };
        break;
      }
      case "secret": {
        (options.bindings ??= {})[name] = binding.unencrypted;
        break;
      }
      case "secrets_store_secret": {
        options.secretsStoreSecrets = {
          ...((options.secretsStoreSecrets as
            | Record<string, { store_id: string; secret_name: string }>
            | undefined) ?? {}),
          [name]: {
            store_id: binding.storeId,
            secret_name: binding.name,
          },
        };
        break;
      }
      case "secret_key": {
        throw new Error(
          `Secret key bindings are not supported for locally emulated workers. Worker "${name}" is locally emulated but is bound to secret key "${name}".`,
        );
      }
      case "service": {
        if (!("id" in binding)) {
          throw new Error(
            `Service bindings must have an id. Worker "${name}" is bound to service "${name}" but does not have an id.`,
          );
        }
        if (isRemoteEnabled(binding)) {
          (options.serviceBindings ??= {})[name] = {
            name: binding.name,
            remoteProxyConnectionString,
          };
        } else {
          (options.serviceBindings ??= {})[name] = binding.name;
        }
        break;
      }
      case "vectorize": {
        assert(
          remoteProxyConnectionString,
          `Binding "${name}" of type "${binding.type}" requires a remoteProxyConnectionString, but none was provided.`,
        );
        (options.vectorize ??= {})[name] = {
          index_name: binding.name,
          remoteProxyConnectionString,
        };
        break;
      }
      case "version_metadata": {
        // This is how Wrangler does it:
        // https://github.com/cloudflare/workers-sdk/blob/70ba9fbf905a9ba5fe158d0bc8d48f6bf31712a2/packages/wrangler/src/dev/miniflare.ts#L881
        (options.bindings ??= {})[name] = {
          id: crypto.randomUUID(),
          tag: "",
          timestamp: "0",
        };
        break;
      }
      case "workflow": {
        (options.workflows ??= {})[name] = {
          name: binding.workflowName,
          className: binding.className,
          scriptName: binding.scriptName,
          // remoteProxyConnectionString:
          //   "local" in binding && binding.local
          //     ? undefined
          //     : remoteProxyConnectionString,
        };
        break;
      }
      case "container": {
        (options.durableObjects ??= {})[name] = {
          className: binding.className,
          scriptName: binding.scriptName,
          useSQLite: binding.sqlite,
          container: {
            imageName: binding.image.name,
          },
          // namespaceId: binding.namespaceId,
          // unsafeUniqueKey?: string | typeof kUnsafeEphemeralUniqueKey | undefined;
          // unsafePreventEviction?: boolean | undefined;
          // remoteProxyConnectionString: binding.local
          //   ? undefined
          //   : remoteProxyConnectionString,
        };
        if (!binding.scriptName || binding.scriptName === workerName) {
          options.unsafeDirectSockets!.push({
            entrypoint: binding.className,
            proxy: true,
          });
        }
        break;
      }
      default: {
        assertNever(binding);
      }
    }
  }
  for (const eventSource of eventSources ?? []) {
    const queue = "queue" in eventSource ? eventSource.queue : eventSource;
    if (queue.dev?.remote !== false) {
      throw new Error(
        `Locally emulated workers cannot consume remote queues. Worker "${workerName}" is locally emulated but is consuming remote queue "${queue.name}".`,
      );
    }
    ((options.queueConsumers ??= []) as string[]).push(queue.name);
  }
  return options;
}
