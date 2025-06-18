import {
  kCurrentWorker,
  type MixedModeConnectionString,
  type WorkerOptions,
} from "miniflare";
import assert from "node:assert";
import { assertNever } from "../../util/assert-never.ts";
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
  remote: boolean;
  port: number;
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
  "durable_object_namespace",
  "images",
  "kv_namespace",
  "r2_bucket",
  "queue",
  "service",
  "workflow",
] satisfies BindingType[];

type RemoteBindingType =
  | (typeof REMOTE_ONLY_BINDING_TYPES)[number]
  | (typeof REMOTE_OPTIONAL_BINDING_TYPES)[number];

type RemoteBinding = Extract<Binding, { type: RemoteBindingType }>;

export function buildRemoteBindings(
  input: Pick<MiniflareWorkerOptions, "bindings" | "remote">,
) {
  const bindings: WorkerBindingSpec[] = [];
  for (const [name, binding] of Object.entries(input.bindings ?? {})) {
    if (isRemoteOnlyBinding(binding)) {
      bindings.push(buildRemoteBinding(name, binding));
    } else if (input.remote && isRemoteOptionalBinding(binding)) {
      bindings.push(buildRemoteBinding(name, binding));
    }
  }
  return bindings;
}

function isRemoteOptionalBinding(binding: Binding): binding is RemoteBinding {
  return (
    typeof binding !== "string" &&
    binding !== Self &&
    REMOTE_OPTIONAL_BINDING_TYPES.includes(binding.type as any)
  );
}

function isRemoteOnlyBinding(binding: Binding): binding is RemoteBinding {
  return (
    typeof binding !== "string" &&
    binding !== Self &&
    REMOTE_ONLY_BINDING_TYPES.includes(binding.type as any)
  );
}

function buildRemoteBinding(
  name: string,
  binding: RemoteBinding,
): WorkerBindingSpec {
  switch (binding.type) {
    case "ai": {
      return {
        type: "ai",
        name,
      };
    }
    case "ai_gateway": {
      return {
        type: "ai",
        name,
      };
    }
    case "browser": {
      return {
        type: "browser",
        name,
      };
    }
    case "d1": {
      return {
        type: "d1",
        name,
        id: binding.id,
      };
    }
    case "dispatch_namespace": {
      return {
        type: "dispatch_namespace",
        name,
        namespace: binding.namespace,
      };
    }
    case "durable_object_namespace": {
      return {
        type: "durable_object_namespace",
        name,
        class_name: binding.className,
        script_name: binding.scriptName,
      };
    }
    case "images": {
      return {
        type: "images",
        name,
      };
    }
    case "kv_namespace": {
      return {
        type: "kv_namespace",
        name,
        namespace_id:
          "namespaceId" in binding ? binding.namespaceId : binding.id,
      };
    }
    case "queue": {
      return {
        type: "queue",
        name,
        queue_name: binding.name,
      };
    }
    case "r2_bucket": {
      return {
        type: "r2_bucket",
        name,
        bucket_name: binding.name,
      };
    }
    case "service": {
      return {
        type: "service",
        name,
        service: "service" in binding ? binding.service : binding.name,
      };
    }
    case "vectorize": {
      return {
        type: "vectorize",
        name,
        index_name: binding.name,
      };
    }
    case "workflow": {
      return {
        type: "workflow",
        name,
        workflow_name: binding.workflowName,
        class_name: binding.className,
        script_name: binding.scriptName,
      };
    }
    default: {
      assertNever(binding);
    }
  }
}

export function buildMiniflareWorkerOptions({
  name,
  script,
  bindings,
  format,
  eventSources,
  compatibilityDate,
  compatibilityFlags,
  remote,
  mixedModeConnectionString,
}: MiniflareWorkerOptions & {
  mixedModeConnectionString: MixedModeConnectionString | undefined;
}): WorkerOptions {
  const options: WorkerOptions = {
    name,
    script,
    modules: format !== "cjs",
    compatibilityDate,
    compatibilityFlags,
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
          mixedModeConnectionString,
          `Binding "${name}" of type "${binding.type}" requires a mixedModeConnectionString, but none was provided.`,
        );
        options.ai = {
          binding: name,
          mixedModeConnectionString,
        };
        break;
      }
      case "ai_gateway": {
        assert(
          mixedModeConnectionString,
          `Binding "${name}" of type "${binding.type}" requires a mixedModeConnectionString, but none was provided.`,
        );
        options.ai = {
          binding: name,
          mixedModeConnectionString,
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
          mixedModeConnectionString,
          `Binding "${name}" of type "${binding.type}" requires a mixedModeConnectionString, but none was provided.`,
        );
        options.browserRendering = {
          binding: name,
          mixedModeConnectionString,
        };
        break;
      }
      case "d1": {
        (
          (options.d1Databases ??= {}) as Record<
            string,
            {
              id: string;
              mixedModeConnectionString?: MixedModeConnectionString;
            }
          >
        )[name] = {
          id: binding.id,
          mixedModeConnectionString: remote
            ? mixedModeConnectionString
            : undefined,
        };
        break;
      }
      case "dispatch_namespace": {
        assert(
          mixedModeConnectionString,
          `Binding "${name}" of type "${binding.type}" requires a mixedModeConnectionString, but none was provided.`,
        );
        (options.dispatchNamespaces ??= {})[name] = {
          namespace: binding.namespace,
          mixedModeConnectionString,
        };
        break;
      }
      case "durable_object_namespace": {
        (options.durableObjects ??= {})[name] = {
          className: binding.className,
          scriptName: binding.scriptName,
          useSQLite: binding.sqlite,
          // namespaceId
          // unsafeUniqueKey?: string | typeof kUnsafeEphemeralUniqueKey | undefined;
          // unsafePreventEviction?: boolean | undefined;
          mixedModeConnectionString: remote
            ? mixedModeConnectionString
            : undefined,
        };
        break;
      }
      case "hyperdrive": {
        if ("access_client_id" in binding.origin) {
          throw new Error("Hyperdrive with access is not supported");
        }
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
          mixedModeConnectionString: remote
            ? mixedModeConnectionString
            : undefined,
        };
        break;
      }
      case "json": {
        (options.bindings ??= {})[name] = binding.json;
        break;
      }
      case "kv_namespace": {
        (
          (options.kvNamespaces ??= {}) as Record<
            string,
            {
              id: string;
              mixedModeConnectionString?: MixedModeConnectionString;
            }
          >
        )[name] = {
          id: "id" in binding ? binding.id : binding.namespaceId,
          mixedModeConnectionString: remote
            ? mixedModeConnectionString
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
              mixedModeConnectionString?: MixedModeConnectionString;
            }
          >
        )[name] = {
          queueName: binding.name,
          deliveryDelay: binding.settings?.deliveryDelay,
          mixedModeConnectionString: remote
            ? mixedModeConnectionString
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
              mixedModeConnectionString?: MixedModeConnectionString;
            }
          >
        )[name] = {
          id: binding.name,
          mixedModeConnectionString: remote
            ? mixedModeConnectionString
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
      case "service": {
        if ("service" in binding) {
          // WorkerRef
        } else {
          // Worker | WorkerStub
          (options.serviceBindings ??= {})[name] = {
            name: binding.name,
            mixedModeConnectionString: remote
              ? mixedModeConnectionString
              : undefined,
          };
        }
        break;
      }
      case "vectorize": {
        assert(
          mixedModeConnectionString,
          `Binding "${name}" of type "${binding.type}" requires a mixedModeConnectionString, but none was provided.`,
        );
        (options.vectorize ??= {})[name] = {
          index_name: binding.name,
          mixedModeConnectionString,
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
          mixedModeConnectionString: remote
            ? mixedModeConnectionString
            : undefined,
        };
        break;
      }
      default: {
        const _: never = binding;
        throw new Error(`Unknown binding type: ${_}`);
      }
    }
  }
  for (const eventSource of eventSources ?? []) {
    options.queueConsumers = [
      ...((options.queueConsumers as string[]) ?? []),
      "name" in eventSource ? eventSource.name : eventSource.queue.name,
    ];
  }
  return options;
}
