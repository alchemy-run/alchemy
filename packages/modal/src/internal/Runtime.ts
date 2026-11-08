import * as classes from "@distilled.cloud/modal/classes";
import * as functions from "@distilled.cloud/modal/functions";
import * as secret from "@distilled.cloud/modal/secret";
import { isResolved } from "alchemy/Diff";
import type { Input } from "alchemy/Input";
import { Stack } from "alchemy/Stack";
import { sha256Object } from "alchemy/Util/sha256";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { ContainerProps, Ref } from "../Container.ts";
import { gpuConfig } from "../ImageBuild.ts";
import { envNameOf, objectName, seconds } from "../internal.ts";
import {
  boundCapabilities,
  boundMounts,
  type ModalMounts,
  type Mount,
  type MountBindings,
  modalMountsOf,
} from "../Mounts.ts";
import type { Providers } from "../Providers.ts";
import { putSecret } from "../Secret.ts";
import { resolveDeclarations } from "./Declared.ts";
import {
  buildRuntimeImage,
  classTag,
  clientMount,
  DEFAULT_PORT,
  entrypointMount,
  ModalDeployUnexpectedResponse,
  planRuntimeImage,
  publishFunction,
} from "./Deploy.ts";
import { ENTRYPOINT_MODULE } from "./Entrypoint.ts";
import { RPC_CALLERS_ENV, type RpcCallerBinding, rpcCallersOf } from "./RpcAuth.ts";

/** What a runtime's bindings attach: mounts, and the keys of RPC callers. */
type RuntimeBindings = ReadonlyArray<{
  readonly data: { readonly mounts?: MountBindings[number]["data"]["mounts"] } & RpcCallerBinding;
}>;

/** Attributes shared by `Modal.Function` and `Modal.Server`. */
export interface RuntimeAttributes {
  /** Function ID (`fu-…`). */
  functionId: string;
  /** Name of the function in its App. */
  name: string;
  /** The App the function is deployed in. */
  appId: string;
  /** Name of that App. */
  appName: string | undefined;
  /** Environment of that App. */
  environment: string | undefined;
  /** The image with the bundled program (`im-…`). */
  imageId: string;
  /** The Modal Secret holding the program's env (bindings' credentials included). */
  secretId: string;
  /** Name of that secret. */
  secretName: string;
  /** Port the program listens on. */
  port: number;
  /** The command the entrypoint starts. */
  command: string[];
  /** Content hash of the bundle, image and function definition. */
  hash: string;
  /** The class (`cs-…`) of a function with RPC methods, which Modal runs as a class. */
  classId?: string | undefined;
}

/** What differs between a Function and a Server. */
export interface RuntimeKind<P extends ContainerProps> {
  /** Resource type, e.g. `Modal.Function`. */
  readonly type: string;
  /** The Function fields specific to the kind (webhook, schedule, HTTP config, ...). */
  readonly definition: (
    props: P,
    context: { readonly port: number; readonly startupTimeout: number },
  ) => functions.Function;
  /** The program's bootstrap for an Effect-native `main`. */
  readonly bootstrap: (handler: string) => (importPath: string) => string;
  /** Env the kind adds to the program's (e.g. turning RPC on). */
  readonly env?: (props: P) => Record<string, string>;
}

const resolveRef = <T>(value: Ref<T>) =>
  Effect.isEffect(value) ? (value as Effect.Effect<T, never, Providers>) : Effect.succeed(value);

/**
 * `{ app: Coder, mounts: [{ volume: Data, path: "/data" }] }` at module scope
 * holds Effects: yield them so the resources are registered and the props
 * hold their resolved attributes at reconcile.
 */
export const resolveContainerProps = <P extends ContainerProps>(_id: string, props: P) =>
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return props;
    const app = yield* resolveRef(props.app);
    const proxy = props.proxy === undefined ? undefined : yield* resolveRef(props.proxy);
    const secrets =
      props.secrets === undefined ? undefined : yield* Effect.forEach(props.secrets, resolveRef);
    const mounts =
      props.mounts === undefined
        ? undefined
        : ((yield* resolveDeclarations(props.mounts)) as Mount[]);
    return { ...props, app, proxy, secrets, mounts };
  });

/** The resolved app of the props. */
export const appOf = (value: unknown) => {
  const rec = (value ?? {}) as { appId?: string; name?: string; environment?: unknown };
  return { appId: rec.appId ?? "", appName: rec.name, environment: envNameOf(rec.environment) };
};

const idOf = (value: unknown, key: string): string | undefined =>
  typeof value === "object" && value !== null && key in value
    ? ((value as Record<string, unknown>)[key] as string | undefined)
    : undefined;

/** An env value as a string, as the program's `process.env` sees it. */
const envText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Redacted.isRedacted(value)
      ? String(Redacted.value(value))
      : JSON.stringify(value ?? null);

/** The function definition fields every kind shares. */
const baseDefinition = (
  props: ContainerProps,
  context: {
    readonly tag: string;
    readonly appName: string | undefined;
    readonly timeout: number;
    readonly startupTimeout: number;
  },
  mounts: ModalMounts,
): functions.Function => ({
  moduleName: ENTRYPOINT_MODULE,
  functionName: context.tag,
  definitionType: "DEFINITION_TYPE_FILE",
  functionType: "FUNCTION_TYPE_FUNCTION",
  resources: {
    milliCpu: props.cpu !== undefined ? Math.round(props.cpu * 1000) : undefined,
    milliCpuMax: props.cpuLimit !== undefined ? Math.round(props.cpuLimit * 1000) : undefined,
    memoryMb: props.memory,
    memoryMbMax: props.memoryLimit,
    gpuConfig: gpuConfig(props.gpu),
    ephemeralDiskMb: props.ephemeralDisk,
  },
  volumeMounts: mounts.volumeMounts,
  cloudBucketMounts: mounts.cloudBucketMounts,
  proxyId: idOf(props.proxy, "proxyId"),
  timeoutSecs: Math.round(context.timeout),
  startupTimeoutSecs: Math.round(context.startupTimeout),
  cloudProviderStr: props.cloud ?? "",
  appName: context.appName ?? "",
  schedulerPlacement:
    props.regions !== undefined || props.nonpreemptible
      ? { regions: props.regions, nonpreemptible: props.nonpreemptible }
      : undefined,
  autoscalerSettings: {
    minContainers: props.minContainers,
    maxContainers: props.maxContainers,
    bufferContainers: props.bufferContainers,
    scaleupWindow: props.scaleupWindow,
    scaledownWindow: props.scaledownWindow,
  },
  // Older mirrors of `autoscalerSettings` the Python client still sets.
  warmPoolSize: props.minContainers ?? 0,
  concurrencyLimit: props.maxContainers ?? 0,
  ExperimentalBufferContainers: props.bufferContainers ?? 0,
  taskIdleTimeoutSecs: props.scaledownWindow ?? 0,
  checkpointingEnabled: props.enableMemorySnapshot,
  blockNetwork: props.blockNetwork,
  untrusted: props.restrictModalAccess,
  i6pnEnabled: props.i6pn,
  methodDefinitionsSet: true,
  mountClientDependencies: true,
  ExperimentalConcurrentCancellations: true,
});

/**
 * The lifecycle shared by every Modal runtime: a function in an App whose
 * container runs the bundled program behind Alchemy's Python entrypoint.
 *
 * 1. the program's env goes into a Modal Secret (values never enter the image);
 * 2. the image is the base plus standalone Python plus the bundle, built by
 *    Modal and reused while its inputs don't change;
 * 3. `FunctionCreate` writes the definition (with the entrypoint and client
 *    mounts), updating the existing function in place;
 * 4. the App is republished with the function, keeping its other functions.
 */
export const runtimeLifecycle = <P extends ContainerProps>(kind: RuntimeKind<P>) =>
  Effect.gen(function* () {
    const stack = yield* Stack;

    const prepare = Effect.fn(function* (id: string, news: P, bindings: RuntimeBindings) {
      const port = news.port ?? DEFAULT_PORT;
      const tag = news.name ?? id;
      const app = appOf(news.app);
      const timeout = seconds(news.timeout) ?? 300;
      const startupTimeout = seconds(news.startupTimeout) ?? timeout;
      const image = yield* planRuntimeImage(
        kind.type,
        news,
        port,
        news.isExternal ? undefined : kind.bootstrap(news.handler ?? "default"),
        boundCapabilities(bindings),
      );
      // The props' mounts, then the ones `Modal.MountVolume` / `MountBucket` bound.
      const mounts = yield* modalMountsOf([...(news.mounts ?? []), ...boundMounts(bindings)]);
      const base = baseDefinition(
        news,
        { tag, appName: app.appName, timeout, startupTimeout },
        mounts,
      );
      const specific = kind.definition(news, { port, startupTimeout });
      const definition: functions.Function = {
        ...base,
        ...specific,
        // A class's service function is named `<tag>.*`, as Modal's clients name it.
        functionName: specific.isClass ? classTag(tag) : tag,
        autoscalerSettings: { ...base.autoscalerSettings, ...specific.autoscalerSettings },
      };
      const secretIds = (news.secrets ?? []).flatMap((s) => idOf(s, "secretId") ?? []);
      const env = {
        ...Object.fromEntries(
          Object.entries(news.env ?? {}).map(([key, value]) => [key, envText(value)]),
        ),
        ...kind.env?.(news),
        // The callers whose keys open the program's RPC methods.
        ...(rpcCallersOf(bindings).length > 0
          ? { [RPC_CALLERS_ENV]: JSON.stringify(rpcCallersOf(bindings)) }
          : {}),
      };
      const hash = yield* sha256Object({ image: image.hash, definition, secretIds, env });
      return { port, tag, app, image, definition, secretIds, env, hash };
    });

    return {
      stables: ["appId", "name", "secretName"] as Array<keyof RuntimeAttributes>,
      diff: Effect.fn(function* ({
        id,
        news,
        output,
        newBindings,
      }: {
        id: string;
        news: Input<P>;
        output: RuntimeAttributes | undefined;
        newBindings: Input<RuntimeBindings>;
      }) {
        if (!isResolved(news) || !isResolved(newBindings) || output === undefined) {
          return undefined;
        }
        if (appOf(news.app).appId !== output.appId) return { action: "replace" } as const;
        if ((news.name ?? id) !== output.name) return { action: "replace" } as const;
        const { hash } = yield* prepare(id, news, newBindings);
        return hash !== output.hash ? ({ action: "update" } as const) : undefined;
      }),
      read: Effect.fn(function* ({ output }: { output: RuntimeAttributes | undefined }) {
        if (output === undefined) return undefined;
        const found = yield* functions
          .functionGetById({ functionId: output.functionId })
          .pipe(Effect.catchTag("FunctionNotFound", () => Effect.undefined));
        return found?.function ? output : undefined;
      }),
      reconcile: Effect.fn(function* ({
        id,
        news,
        output,
        session,
        bindings,
      }: {
        id: string;
        news: P;
        output: RuntimeAttributes | undefined;
        session: { note: (message: string) => Effect.Effect<void> };
        bindings: RuntimeBindings;
      }) {
        const {
          port,
          tag,
          app,
          image,
          definition,
          secretIds,
          env: programEnv,
          hash,
        } = yield* prepare(id, news, bindings);
        for (const warning of image.warnings) yield* session.note(warning);
        const secretName = output?.secretName ?? `${yield* objectName(id, undefined, 58)}-env`;

        // Sync the program's env (bindings' credentials included) into the
        // secret the function attaches; values never enter the image.
        const env: Record<string, string> = {
          ALCHEMY_STACK_NAME: stack.name,
          ALCHEMY_STAGE: stack.stage,
          ALCHEMY_PHASE: "runtime",
          ALCHEMY_COMMAND: JSON.stringify(image.command),
          HOST: "0.0.0.0",
          PORT: String(port),
        };
        Object.assign(env, programEnv);
        const stored = yield* putSecret(
          yield* secret.secretGetOrCreate,
          secretName,
          app.environment,
          env,
        );

        // Ensure the image: Modal reuses a cached build for the same inputs.
        const imageId =
          output !== undefined && output.hash === hash && output.appId === app.appId
            ? output.imageId
            : yield* buildRuntimeImage(app.appId, image, {
                builderVersion: news.builderVersion,
                gpu: news.gpu,
                note: session.note,
              });

        const mountIds = [yield* clientMount, yield* entrypointMount(app.appId)];
        yield* session.note(`Deploying ${kind.type} ${tag}...`);
        const created = yield* functions.createFunction({
          appId: app.appId,
          function: {
            ...definition,
            imageId,
            mountIds,
            secretIds: [stored.secretId, ...secretIds],
          },
          existingFunctionId: output?.appId === app.appId ? output.functionId : undefined,
        });
        if (!created.functionId) {
          return yield* new ModalDeployUnexpectedResponse({
            message: `Modal returned no id for function ${tag}`,
          });
        }
        for (const warning of created.serverWarnings ?? []) {
          if (warning.message) yield* session.note(warning.message);
        }
        // A class function needs its class: its containers hydrate it from
        // the App layout, under the function's name.
        const classId = definition.isClass
          ? (yield* classes.createClass({
              appId: app.appId,
              existingClassId: output?.appId === app.appId ? output.classId : undefined,
              onlyClassFunction: true,
            })).classId
          : undefined;
        yield* publishFunction(app, tag, {
          functionId: created.functionId,
          definitionId: created.handleMetadata?.definitionId,
          classId,
        });
        return {
          attributes: {
            functionId: created.functionId,
            name: tag,
            appId: app.appId,
            appName: app.appName,
            environment: app.environment,
            imageId,
            secretId: stored.secretId,
            secretName,
            port,
            command: image.command,
            hash,
            classId,
          } satisfies RuntimeAttributes,
          metadata: created.handleMetadata,
        };
      }),
      delete: Effect.fn(function* ({ output }: { output: RuntimeAttributes }) {
        // Republish the App without the function; stopping the App (its own
        // resource) is what removes everything else.
        yield* publishFunction(output, output.name, undefined).pipe(
          Effect.catchTag("AppNotFound", () => Effect.void),
        );
        yield* secret
          .deleteSecret({ secretId: output.secretId })
          .pipe(Effect.catchTag("SecretNotFound", () => Effect.void));
        // The image stays: Modal content-addresses builds, so another
        // function or sandbox may boot from the same image id.
      }),
    };
  });
