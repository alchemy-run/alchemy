import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { loadInternalWorker } from "../../internal/internal-worker.ts";
const DispatchNamespaceBindingWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/dispatch-namespace/dispatch-namespace.worker",
    ),
};
const DispatchShimForwardWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/dispatch-namespace/DispatchShimForward.worker",
    ),
};
import { DEFAULT_COMPATIBILITY_DATE } from "../../internal/constants.ts";
import {
  formatExtensionModule,
  formatInternalWorkerModules,
} from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import type { RemoteBindings } from "../../remote-bindings/RemoteBindings.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";

export class DispatchNamespace extends Plugin.Service<
  DispatchNamespace,
  {
    /**
     * Record a dispatch binding that goes through a deployed shim (see
     * {@link shim}) and resolve the local forwarder service it targets.
     */
    readonly registerShim: (
      props: DispatchNamespaceShimProps,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
  }
>()("cloudflare-runtime/plugin/DispatchNamespace") {}

const EXTENSION_MODULE_NAME = "cloudflare-runtime:dispatch-namespace";

const shimServiceName = (binding: string): string => `dispatch-shim:${binding}`;

/**
 * The local forwarder for one shimmed binding. Its fetches use workerd's
 * default global outbound (the internet), where the shim lives.
 */
const shimService = Effect.fnUntraced(function* (props: DispatchNamespaceShimProps) {
  return {
    name: shimServiceName(props.binding),
    worker: {
      compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
      modules: formatInternalWorkerModules(yield* Effect.promise(DispatchShimForwardWorker.worker)),
      bindings: [
        { name: "SHIM_URL", text: props.url },
        { name: "SHIM_TOKEN", text: props.token },
      ],
    },
  };
});

export const DispatchNamespaceLive = Layer.succeed(
  DispatchNamespace,
  DispatchNamespace.of(
    Effect.gen(function* () {
      const esModule = yield* formatExtensionModule(DispatchNamespaceBindingWorker);
      const shims: Array<DispatchNamespaceShimProps> = [];
      return {
        extensions: [
          {
            modules: [
              {
                name: EXTENSION_MODULE_NAME,
                internal: true,
                esModule,
              },
            ],
          },
        ],
        api: {
          registerShim: (props: DispatchNamespaceShimProps) =>
            Effect.sync(() => {
              shims.push(props);
              return { name: shimServiceName(props.binding) };
            }),
        },
        defer: Effect.suspend(() =>
          Effect.forEach(shims, shimService, { concurrency: "unbounded" }).pipe(
            Effect.map((services) => ({ services })),
          ),
        ),
      };
    }),
  ),
);

export interface DispatchNamespaceProps {
  readonly binding: string;
  readonly namespace: string;
  readonly outbound?: {
    worker?: { service?: string; environment?: string };
    params?: Array<{ name: string }>;
  };
}

export interface DispatchNamespaceShimProps {
  readonly binding: string;
  /** The deployed shim Worker's URL. */
  readonly url: string;
  /** The token the shim requires, sent in `x-alchemy-dispatch-token`. */
  readonly token: string;
}

/**
 * Bind to a deployed dispatch namespace through a deployed shim Worker that
 * holds the binding. Cloudflare's preview refuses a dispatch binding with an
 * outbound Worker, so {@link remote} can't carry one; the shim can. Only
 * `fetch` on a dispatched Worker crosses.
 */
export const shim = (props: DispatchNamespaceShimProps): BindingHook<DispatchNamespace> =>
  Plugin.use(DispatchNamespace, (plugin) =>
    Effect.map(plugin.api.registerShim(props), (service) => ({
      name: props.binding,
      wrapped: {
        moduleName: EXTENSION_MODULE_NAME,
        innerBindings: [{ name: "proxyClient", service }],
      },
    })),
  );

/**
 * Bind to a deployed dispatch namespace via the remote bindings proxy.
 *
 * Wraps the remote-bindings client service so user code can call
 * `env.BINDING.get(name, args, options).fetch(...)` against a user worker
 * dispatched from the remote namespace.
 */
export const remote = (
  props: DispatchNamespaceProps,
): BindingHook<RemoteBindings | DispatchNamespace> =>
  Plugin.use(DispatchNamespace, () =>
    makeRemoteBinding(
      {
        name: props.binding,
        type: "dispatch_namespace",
        namespace: props.namespace,
        outbound: props.outbound,
      },
      (service) => ({
        name: props.binding,
        wrapped: {
          moduleName: EXTENSION_MODULE_NAME,
          innerBindings: [{ name: "proxyClient", service }],
        },
      }),
    ),
  );
