import * as DurableObjectNamespace from "../core/bindings/DurableObjectNamespace.ts";
import type {
  BindingHooks,
  DurableObjectNamespace as RuntimeDurableObject,
} from "../core/index.ts";
import type * as vite from "vite";
import type { CloudflareVitePluginOptions } from "./plugin.ts";

/**
 * A Durable Object that a framework generates as part of its Worker entry.
 *
 * Alchemy owns the Cloudflare Vite plugin and deploy lifecycle. Frameworks
 * contribute this plain declaration from their existing Vite config instead
 * of adding a second Cloudflare plugin instance.
 */
export interface ViteFrameworkDurableObject {
  readonly binding: string;
  readonly className: string;
}

/** The Worker-only portion a Vite framework may contribute to Alchemy. */
export interface ViteFrameworkContribution {
  /**
   * A virtual or file Worker entry. It must preserve and re-export the
   * application's Worker surface because Alchemy deploys exactly one entry.
   */
  readonly main?: string;
  /** Compatibility flags required by the generated Worker. */
  readonly compatibilityFlags?: ReadonlyArray<string>;
  /** Durable Objects exported by the generated Worker entry. */
  readonly durableObjects?: ReadonlyArray<ViteFrameworkDurableObject>;
}

/** A framework config customizer that mutates a Cloudflare-shaped object. */
export type ViteFrameworkWorkerCustomizer = (config: object) => void;

const FRAMEWORK_PLUGIN_NAME = "vite-plugin-cloudflare:alchemy-framework";
const frameworkContributions = new WeakMap<
  CloudflareVitePluginOptions,
  ViteFrameworkContribution
>();
const alchemyWorkerEntries = new WeakMap<
  CloudflareVitePluginOptions,
  string | undefined
>();
const alchemyCompatibilityFlags = new WeakMap<
  CloudflareVitePluginOptions,
  ReadonlyArray<string> | undefined
>();

type PluginWithFrameworkContribution = vite.Plugin & {
  api?: { alchemyCloudflareViteFramework?: () => ViteFrameworkContribution };
};

/**
 * Carry a framework's Cloudflare-shaped Worker configuration to Alchemy's
 * injected runtime plugin.
 *
 * Put this plugin after the framework plugin in `vite.config.ts`. It exposes
 * the conventional Cloudflare plugin name solely for framework compatibility;
 * it never starts workerd or contributes another runtime plugin.
 */
export const cloudflareViteFramework = (
  customize: ViteFrameworkWorkerCustomizer,
): vite.Plugin => {
  let contribution: ViteFrameworkContribution | undefined;
  return {
    name: FRAMEWORK_PLUGIN_NAME,
    config() {
      const config: Record<string, unknown> = {};
      customize(config);
      contribution = normalizeFrameworkContribution(config);
    },
    api: {
      alchemyCloudflareViteFramework: () => contribution ?? {},
    },
  } as vite.Plugin;
};

/** @internal Called by Alchemy's injected Cloudflare Vite plugin. */
export const applyViteFrameworkContributions = (
  options: CloudflareVitePluginOptions,
  userConfig: vite.UserConfig,
): void => {
  const contributions = flattenPluginOptions(userConfig.plugins).flatMap(
    (plugin) => {
      const contribution = (
        plugin as PluginWithFrameworkContribution
      ).api?.alchemyCloudflareViteFramework?.();
      return contribution ? [contribution] : [];
    },
  );
  const contribution = mergeFrameworkContributions(contributions);
  if (!alchemyWorkerEntries.has(options)) {
    alchemyWorkerEntries.set(options, options.main);
    alchemyCompatibilityFlags.set(options, options.compatibilityFlags);
  }
  const alchemyMain = alchemyWorkerEntries.get(options);

  if (
    alchemyMain !== undefined &&
    contribution.main !== undefined &&
    alchemyMain !== contribution.main
  ) {
    throw new Error(
      `Alchemy's Vite Worker entry "${alchemyMain}" conflicts with framework-contributed entry "${contribution.main}". The framework entry must preserve and re-export the application Worker instead of declaring a second main.`,
    );
  }
  frameworkContributions.set(options, contribution);

  // `optionsPlugin` reads these values while resolving the Vite config. The
  // mutation is idempotent across Vite config reloads (the merge dedupes
  // flags), while the framework-only local Worker shape stays in the WeakMap.
  options.main = alchemyMain ?? contribution.main;
  options.compatibilityFlags = mergeUnique(
    alchemyCompatibilityFlags.get(options),
    contribution.compatibilityFlags,
  );
};

/** @internal The normalized declaration captured during Vite config loading. */
export const getViteFrameworkContribution = (
  options: CloudflareVitePluginOptions,
): ViteFrameworkContribution => frameworkContributions.get(options) ?? {};

/** @internal Add framework DOs to the local runtime without changing bindings. */
export const withViteFrameworkWorker = <B extends BindingHooks>(
  options: CloudflareVitePluginOptions<B>,
) => {
  const contribution = getViteFrameworkContribution(options);
  const durableObjects = contribution.durableObjects ?? [];
  if (durableObjects.length === 0) return options.worker;
  const worker = options.worker;
  const applicationBindings = new Map(
    (worker?.bindings ?? []).flatMap((hook) => {
      const declaration = DurableObjectNamespace.getLocalDeclaration(hook);
      return declaration ? [[declaration.binding, declaration] as const] : [];
    }),
  );
  const hostedClasses = new Set(
    worker?.durableObjectNamespaces?.map(({ className }) => className) ?? [],
  );
  const bindings: Array<BindingHooks[number]> = [...(worker?.bindings ?? [])];
  const namespaces: Array<RuntimeDurableObject> = [
    ...(worker?.durableObjectNamespaces ?? []),
  ];
  for (const durableObject of durableObjects) {
    const applicationBinding = applicationBindings.get(durableObject.binding);
    if (applicationBinding) {
      const localToThisWorker =
        applicationBinding.scriptName === undefined ||
        applicationBinding.scriptName === worker?.name;
      if (
        localToThisWorker &&
        applicationBinding.className === durableObject.className
      ) {
        continue;
      }
      throw new Error(
        `Framework-contributed Durable Object binding "${durableObject.binding}" conflicts with the application Worker.`,
      );
    }
    bindings.push(
      DurableObjectNamespace.local({
        binding: durableObject.binding,
        className: durableObject.className,
      }),
    );
    if (!hostedClasses.has(durableObject.className)) {
      hostedClasses.add(durableObject.className);
      namespaces.push({ className: durableObject.className, sql: true });
    }
  }
  return {
    ...worker,
    bindings,
    durableObjectNamespaces: namespaces,
  };
};

const normalizeFrameworkContribution = (
  config: Record<string, unknown>,
): ViteFrameworkContribution => {
  const durableObjectBindings = isRecord(config.durable_objects)
    ? config.durable_objects.bindings
    : undefined;
  const durableObjects = Array.isArray(durableObjectBindings)
    ? durableObjectBindings.flatMap((binding) => {
        if (
          !isRecord(binding) ||
          typeof binding.name !== "string" ||
          typeof binding.class_name !== "string"
        ) {
          return [];
        }
        return [{ binding: binding.name, className: binding.class_name }];
      })
    : [];
  return {
    ...(typeof config.main === "string" ? { main: config.main } : {}),
    ...(Array.isArray(config.compatibility_flags)
      ? {
          compatibilityFlags: config.compatibility_flags.filter(
            (flag): flag is string => typeof flag === "string",
          ),
        }
      : {}),
    ...(durableObjects.length > 0 ? { durableObjects } : {}),
  };
};

const mergeFrameworkContributions = (
  contributions: ReadonlyArray<ViteFrameworkContribution>,
): ViteFrameworkContribution => {
  const durableObjects = new Map<string, ViteFrameworkDurableObject>();
  for (const contribution of contributions) {
    for (const durableObject of contribution.durableObjects ?? []) {
      const previous = durableObjects.get(durableObject.binding);
      if (previous && previous.className !== durableObject.className) {
        throw new Error(
          `Framework Vite contributions disagree about Durable Object binding "${durableObject.binding}".`,
        );
      }
      durableObjects.set(durableObject.binding, durableObject);
    }
  }
  const mains = new Set(
    contributions.flatMap((contribution) =>
      contribution.main === undefined ? [] : [contribution.main],
    ),
  );
  if (mains.size > 1) {
    throw new Error(
      `Framework Vite contributions disagree about the Worker entry: ${[
        ...mains,
      ]
        .map((main) => `"${main}"`)
        .join(", ")}.`,
    );
  }
  const main = mains.values().next().value;
  return {
    ...(main ? { main } : {}),
    compatibilityFlags: mergeUnique(
      ...contributions.map((contribution) => contribution.compatibilityFlags),
    ),
    ...(durableObjects.size > 0
      ? { durableObjects: [...durableObjects.values()] }
      : {}),
  };
};

const mergeUnique = (
  ...values: Array<ReadonlyArray<string> | undefined>
): Array<string> => [...new Set(values.flatMap((value) => value ?? []))];

const flattenPluginOptions = (
  value: vite.PluginOption | undefined,
): Array<vite.Plugin> =>
  Array.isArray(value)
    ? value.flatMap(flattenPluginOptions)
    : value && typeof value === "object" && "name" in value
      ? [value as vite.Plugin]
      : [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
