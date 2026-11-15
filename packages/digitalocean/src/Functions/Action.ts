import * as Fn from "@distilled.cloud/digitalocean/Functions";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { Providers } from "../Providers.ts";

/** The namespace a function lives in: a `Functions.Namespace`, or its attributes. */
export interface NamespaceRef {
  readonly namespaceId: string;
  readonly uuid: string;
  readonly apiHost: string;
  readonly key: Redacted.Redacted<string>;
}

export type ActionProps = {
  /** The namespace to deploy to. A change replaces the function. */
  namespace: NamespaceRef;
  /**
   * Function name in the namespace, optionally `package/name`. A change
   * replaces the function.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Runtime, for example `"nodejs:18"`, `"python:3.11"` or `"go:1.20"`. */
  runtime: string;
  /** Source code of the function. */
  code: string;
  /** Name of the entry function in `code`. @default "main" */
  main?: string;
  /**
   * Serve the function at a public URL (an OpenWhisk web action). The
   * function returns `{ body, statusCode?, headers? }`.
   *
   * @default false
   */
  web?: boolean;
  /** Default parameters every invocation receives. */
  parameters?: Record<string, string | number | boolean | Redacted.Redacted<string>>;
  /** Longest a run may take, in milliseconds. @default 3000 */
  timeoutMs?: number;
  /** Memory, in MiB. @default 256 */
  memoryMb?: number;
};

export type Action = Resource<
  "DigitalOcean.Functions.Action",
  ActionProps,
  {
    /** Function name in the namespace. */
    name: string;
    /** The namespace id, `fn-<uuid>`. */
    namespaceId: string;
    /** The namespace's OpenWhisk API host. */
    apiHost: string;
    /** OpenWhisk version of the deployed function. */
    version: string;
    /** Public URL, for a `web` function. */
    url: string | undefined;
  },
  never,
  Providers
>;

export type ActionAttributes = Action["Attributes"];

/**
 * A function in a DigitalOcean Functions namespace (an OpenWhisk action).
 * Code, runtime, parameters and limits update in place; a new version is
 * deployed only when one of them changes. Set `web: true` to serve the
 * function at a public URL.
 *
 * ### Deploying a Function
 * **Example:** A web function
 * ```typescript
 * const fns = yield* DigitalOcean.Functions.Namespace("fns", { region: "nyc1" });
 * const hello = yield* DigitalOcean.Functions.Action("hello", {
 *   namespace: fns,
 *   runtime: "nodejs:18",
 *   web: true,
 *   code: `function main(args) { return { body: "hello " + (args.name ?? "world") } }`,
 * });
 * // hello.url → https://faas-nyc1-….doserverless.co/api/v1/web/fn-…/default/…
 * ```
 *
 * @see https://docs.digitalocean.com/products/functions/
 *
 * @resource
 * @product Functions
 * @category Compute
 */
export const Action = Resource<Action>("DigitalOcean.Functions.Action");

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

/** Runs a Functions API call signed with the namespace's own key. */
export const withNamespace =
  (namespace: NamespaceRef) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(
        Fn.fromFunctionsKey({
          apiHost: namespace.apiHost,
          user: namespace.uuid,
          secret: namespace.key,
        }),
      ),
    );

const webUrl = (namespace: NamespaceRef, name: string) => {
  const [pkg, fn] = name.includes("/") ? name.split("/", 2) : ["default", name];
  return `${namespace.apiHost}/api/v1/web/${namespace.namespaceId}/${pkg}/${fn}`;
};

const plain = (value: string | number | boolean | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const desiredOf = (news: ActionProps) => ({
  exec: { kind: news.runtime, code: news.code, main: news.main ?? "main" },
  parameters: Object.entries(news.parameters ?? {}).map(([key, value]) => ({
    key,
    value: plain(value),
  })),
  annotations: [{ key: "web-export", value: news.web ?? false }],
  limits: { timeout: news.timeoutMs ?? 3000, memory: news.memoryMb ?? 256 },
});

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const inSync = (observed: Fn.Action, desired: ReturnType<typeof desiredOf>) => {
  const web = (observed.annotations ?? []).find((a) => a.key === "web-export")?.value ?? false;
  return (
    observed.exec?.kind === desired.exec.kind &&
    observed.exec?.code === desired.exec.code &&
    (observed.exec?.main ?? "main") === desired.exec.main &&
    web === desired.annotations[0]!.value &&
    sameJson(
      [...(observed.parameters ?? [])].sort((a, b) => (a.key ?? "").localeCompare(b.key ?? "")),
      [...desired.parameters].sort((a, b) => (a.key ?? "").localeCompare(b.key ?? "")),
    ) &&
    observed.limits?.timeout === desired.limits.timeout &&
    observed.limits?.memory === desired.limits.memory
  );
};

const observe = (namespace: NamespaceRef, name: string) =>
  Fn.getActionByName({ namespace: namespace.namespaceId, actionName: name, code: true }).pipe(
    Effect.asSome,
    Effect.catchTag("NotFound", () => Effect.succeedNone),
    withNamespace(namespace),
  );

const toAttrs = (namespace: NamespaceRef, action: Fn.Action, web: boolean): ActionAttributes => ({
  name: action.name,
  namespaceId: namespace.namespaceId,
  apiHost: namespace.apiHost,
  version: action.version,
  url: web ? webUrl(namespace, action.name) : undefined,
});

export const ActionProvider = () =>
  Provider.succeed(Action, {
    stables: ["namespaceId", "apiHost"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output }) {
      const name = output?.name ?? olds.name ?? (yield* physicalName(id));
      const observed = yield* observe(olds.namespace, name);
      if (Option.isNone(observed)) return undefined;
      const attrs = toAttrs(olds.namespace, observed.value, olds.web ?? false);
      // A generated name is this resource's; a chosen one proves nothing.
      return output !== undefined || olds.name === undefined ? attrs : Unowned(attrs);
    }),
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      if (
        news.namespace.namespaceId !== olds.namespace.namespaceId ||
        (output !== undefined && name !== output.name)
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const desired = desiredOf(news);
      const observed = yield* observe(news.namespace, name);
      if (Option.isSome(observed) && inSync(observed.value, desired)) {
        return toAttrs(news.namespace, observed.value, news.web ?? false);
      }
      const deployed = yield* Fn.updateAction({
        namespace: news.namespace.namespaceId,
        actionName: name,
        overwrite: true,
        ...desired,
      }).pipe(withNamespace(news.namespace));
      return toAttrs(news.namespace, deployed, news.web ?? false);
    }),
    delete: Effect.fn(function* ({ olds, output }) {
      yield* Fn.deleteAction({ namespace: output.namespaceId, actionName: output.name }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        withNamespace(olds.namespace),
      );
    }),
  });
