import * as Fn from "@distilled.cloud/digitalocean/Functions";
import * as Bundle from "alchemy/Bundle/Bundle";
import * as TempRoot from "alchemy/Bundle/TempRoot";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource, ResourceBinding } from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import { moduleExtension } from "alchemy/Util/Node";
import { sha256 } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { Providers } from "../Providers.ts";
import { withNamespace, type NamespaceRef } from "./Action.ts";
import {
  makeFunctionRuntimeContext,
  type FunctionRuntimeContext,
} from "./FunctionRuntimeContext.ts";

export interface FunctionProps extends PlatformProps {
  /**
   * The program. With an Effect implementation (`main: import.meta.url`),
   * the class's `fetch` handler serves requests. With `isExternal: true`,
   * the module's `fetch(request, env)` does.
   */
  main?: string;
  /** Named export to load from `main`. @default "default" */
  handler?: string;
  /** The namespace to deploy to. A change replaces the function. */
  namespace: NamespaceRef;
  /**
   * Function name in the namespace. A change replaces the function.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Node.js runtime. @default "nodejs:18" */
  runtime?: string;
  /** Longest a request may take, in milliseconds (up to 900000). @default 30000 */
  timeoutMs?: number;
  /** Memory, in MiB (128 to 1024). @default 256 */
  memoryMb?: number;
  /**
   * Environment variables. They're stored as the function's default
   * parameters, which callers can't override.
   */
  env?: Record<string, string | Redacted.Redacted<string>>;
  /** Bundler options. */
  bundle?: Bundle.BundleConfig;
}

/** Data a binding attaches to a function. */
export interface FunctionBinding {
  env?: Record<string, unknown>;
}

export type Function = Resource<
  "DigitalOcean.Functions.Function",
  FunctionProps,
  {
    /** Function name in the namespace. */
    name: string;
    /** The namespace id, `fn-<uuid>`. */
    namespaceId: string;
    /** The function's public HTTPS URL. */
    url: string;
    /** The deployed version, bumped on every change. */
    version: string | undefined;
    /** Content hash of the deployed bundle. */
    code: { hash: string };
  },
  FunctionBinding,
  Providers
>;

export type FunctionAttributes = Function["Attributes"];

/**
 * A DigitalOcean Function running your program: an HTTPS endpoint that
 * runs only when it's called, billed per run. The program is bundled into
 * one file and deployed as a web function in a Functions namespace.
 *
 * ### Writing a Function
 * **Example:** An Effect handler
 * ```typescript
 * export default class Hello extends DigitalOcean.Functions.Function<Hello>()(
 *   "Hello",
 *   { main: import.meta.url, namespace: Fns },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         return HttpServerResponse.text(`hello from ${request.url}`);
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * **Example:** An async handler
 * ```typescript
 * // src/hello.ts
 * export default {
 *   async fetch(request: Request) {
 *     return new Response("hello");
 *   },
 * };
 *
 * // alchemy.run.ts
 * const hello = yield* DigitalOcean.Functions.Function("Hello", {
 *   main: "./src/hello.ts",
 *   namespace: fns,
 *   isExternal: true,
 * });
 * ```
 *
 * ### Using Bindings
 * **Example:** Read a secret
 * ```typescript
 * export default class Api extends DigitalOcean.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url, namespace: Fns },
 *   Effect.gen(function* () {
 *     const stripe = yield* DigitalOcean.Security.ReadSecret(Stripe);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const key = yield* stripe.get("STRIPE_KEY");
 *         return HttpServerResponse.text(Redacted.value(key).slice(0, 7));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Security.ReadSecretHttp)),
 * ) {}
 * ```
 *
 * @see https://docs.digitalocean.com/products/functions/
 *
 * @resource
 * @product Functions
 * @category Compute
 */
export const Function: Platform<Function, never, Main<never>, FunctionRuntimeContext> = Platform(
  "DigitalOcean.Functions.Function",
  {
    createRuntimeContext: makeFunctionRuntimeContext,
    // `{ namespace: Namespace(...) }` at module scope is an Effect. Yield it
    // so the namespace is declared and `news.namespace` is its attributes.
    transformProps: (_id, props) =>
      Effect.gen(function* () {
        if (globalThis.__ALCHEMY_RUNTIME__ || !Effect.isEffect(props.namespace)) return props;
        const namespace = yield* props.namespace as Effect.Effect<NamespaceRef, never, Providers>;
        return { ...props, namespace };
      }),
  },
);

export class FunctionBundleFailed extends Data.TaggedError(
  "DigitalOcean.Functions.FunctionBundleFailed",
)<{ readonly message: string }> {}

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const webUrl = (namespace: NamespaceRef, name: string) =>
  `${namespace.apiHost}/api/v1/web/${namespace.namespaceId}/default/${name}`;

/** Bundles `main` with the OpenWhisk bridge into one CommonJS file. */
const bundleFunction = Effect.fn(function* (props: FunctionProps) {
  if (props.main === undefined) {
    return yield* new FunctionBundleFailed({
      message: "DigitalOcean.Functions.Function needs main",
    });
  }
  const realMain = yield* TempRoot.resolveMainPath(props.main);
  const virtual = yield* Bundle.virtualEntryPlugin;
  const bridge = yield* Effect.sync(() =>
    import.meta.resolve(`./FunctionBridge${moduleExtension(import.meta.url)}`),
  );
  const handler = props.handler ?? "default";
  const output = yield* Bundle.build(
    {
      ...props.bundle?.input,
      input: realMain,
      cwd: yield* TempRoot.findCwdForBundle(realMain),
      platform: "node",
      resolve: {
        ...props.bundle?.input?.resolve,
        conditionNames: [...Bundle.NODE_CONDITION_NAMES],
      },
      plugins: [
        props.bundle?.input?.plugins,
        virtual((entry) =>
          props.isExternal
            ? `import { makeAsyncMain } from ${JSON.stringify(bridge)};\nimport * as mod from ${JSON.stringify(entry)};\nexport const main = makeAsyncMain(mod[${JSON.stringify(handler)}] ?? mod);`
            : `import { makeEffectMain } from ${JSON.stringify(bridge)};\nimport { ${handler} as entrypoint } from ${JSON.stringify(entry)};\nexport const main = makeEffectMain(entrypoint);`,
        ),
      ],
    },
    {
      ...props.bundle?.output,
      format: "cjs",
      entryFileNames: "index.js",
      codeSplitting: false,
    },
    props.bundle,
  );
  const file = output.files.find((f) => f.path === "index.js");
  if (file === undefined) {
    return yield* new FunctionBundleFailed({ message: "the bundle produced no index.js" });
  }
  const code =
    typeof file.content === "string" ? file.content : new TextDecoder().decode(file.content);
  return { code, hash: yield* sha256(code) };
});

const plain = (value: unknown): string =>
  Redacted.isRedacted(value)
    ? String(Redacted.value(value))
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

const activeBindings = (bindings: ReadonlyArray<ResourceBinding<FunctionBinding>>) =>
  bindings.filter(
    (binding: ResourceBinding<FunctionBinding> & { action?: string }) =>
      binding.action !== "delete",
  );

const observe = (namespace: NamespaceRef, name: string) =>
  Fn.getAction({ namespace: namespace.namespaceId, action_name: name }).pipe(
    Effect.map(Option.some),
    Effect.catchTag("NotFound", () => Effect.succeedNone),
    withNamespace(namespace),
  );

export const FunctionProvider = () =>
  Provider.succeed(Function, {
    stables: ["namespaceId"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ olds, output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(olds.namespace, output.name);
      return Option.isSome(observed) ? { ...output, version: observed.value.version } : undefined;
    }),
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const name = news.name ?? output.name ?? (yield* physicalName(id));
      if (news.namespace.namespaceId !== olds.namespace.namespaceId || name !== output.name) {
        return { action: "replace" } as const;
      }
      const bundled = yield* bundleFunction(news);
      if (bundled.hash !== output.code.hash) return { action: "update" } as const;
    }),
    reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const stack = yield* Stack;
      const bundled = yield* bundleFunction(news);
      const env: Record<string, unknown> = {
        ...activeBindings(bindings as ReadonlyArray<ResourceBinding<FunctionBinding>>).reduce<
          Record<string, unknown>
        >((all, binding) => ({ ...all, ...binding.data?.env }), {}),
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stack.stage,
        ALCHEMY_PHASE: "runtime",
        ...news.env,
      };
      // `putAction` with `overwrite` is an upsert: the observed state only
      // matters for the version it reports.
      const deployed = yield* Fn.putAction({
        namespace: news.namespace.namespaceId,
        action_name: name,
        overwrite: true,
        exec: { kind: news.runtime ?? "nodejs:18", code: bundled.code, main: "main" },
        parameters: Object.entries(env).map(([key, value]) => ({ key, value: plain(value) })),
        annotations: [
          { key: "web-export", value: true },
          { key: "raw-http", value: true },
          { key: "final", value: true },
        ],
        limits: { timeout: news.timeoutMs ?? 30_000, memory: news.memoryMb ?? 256 },
      }).pipe(withNamespace(news.namespace));
      return {
        name,
        namespaceId: news.namespace.namespaceId,
        url: webUrl(news.namespace, name),
        version: deployed.version,
        code: { hash: bundled.hash },
      };
    }),
    delete: Effect.fn(function* ({ olds, output }) {
      yield* Fn.deleteAction({ namespace: output.namespaceId, action_name: output.name }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        withNamespace(olds.namespace),
      );
    }),
  });
