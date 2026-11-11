import * as DO from "@distilled.cloud/digitalocean";
import type { NamespaceInfo } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type NamespaceProps = {
  /**
   * Namespace label, unique per team. A change replaces the namespace.
   *
   * @default a generated physical name
   */
  label?: string;
  /** Region the functions run in, for example `"nyc1"`. A change replaces the namespace. */
  region: string;
};

export type Namespace = Resource<
  "DigitalOcean.Functions.Namespace",
  NamespaceProps,
  {
    /** The namespace id, `fn-<uuid>`. */
    namespaceId: string;
    /** Namespace UUID; the user half of the namespace's own key. */
    uuid: string;
    /** Namespace label. */
    label: string;
    /** Region the functions run in. */
    region: string;
    /** The OpenWhisk API host the namespace's functions are served from. */
    apiHost: string;
    /** The namespace's master key: `uuid:key` authenticates to `apiHost`. */
    key: Redacted.Redacted<string>;
  },
  never,
  Providers
>;

export type NamespaceAttributes = Namespace["Attributes"];

/**
 * A DigitalOcean Functions namespace: the place functions are deployed to
 * and served from. Each namespace has its own OpenWhisk API host. Deploy
 * code into it with `Functions.Action` and schedule it with
 * `Functions.Trigger`.
 *
 * ### Creating a Namespace
 * **Example:** A namespace in New York
 * ```typescript
 * const fns = yield* DigitalOcean.Functions.Namespace("fns", { region: "nyc1" });
 * ```
 *
 * @see https://docs.digitalocean.com/products/functions/
 *
 * @resource
 * @product Functions
 * @category Compute
 */
export const Namespace = Resource<Namespace>("DigitalOcean.Functions.Namespace");

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const toAttrs = (ns: NamespaceInfo): NamespaceAttributes => ({
  namespaceId: ns.namespace,
  uuid: ns.uuid,
  label: ns.label,
  region: ns.region,
  apiHost: ns.api_host,
  key: typeof ns.key === "string" ? Redacted.make(ns.key) : (ns.key ?? Redacted.make("")),
});

const observeById = (namespaceId: string) =>
  noneIfNotFound(
    DO.getFunctionNamespace({ namespace_id: namespaceId }).pipe(Effect.map((r) => r.namespace)),
  );

const observeByLabel = (label: string) =>
  DO.listFunctionNamespaces({}).pipe(
    Effect.map((r) => Option.fromNullishOr((r.namespaces ?? []).find((ns) => ns.label === label))),
    Effect.flatMap((found) =>
      // The listing omits the key; read the namespace for it.
      Option.isSome(found) ? observeById(found.value.namespace) : Effect.succeedNone,
    ),
  );

export const NamespaceProvider = () =>
  Provider.succeed(Namespace, {
    stables: ["namespaceId", "uuid", "apiHost", "key"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output !== undefined) {
        const byId = yield* observeById(output.namespaceId);
        if (Option.isSome(byId)) return toAttrs(byId.value);
      }
      // A generated label is this resource's; a chosen one proves nothing.
      if (olds.label !== undefined) return undefined;
      const label = yield* physicalName(id);
      const named = yield* observeByLabel(label);
      return Option.getOrUndefined(Option.map(named, toAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.region !== olds.region || news.label !== olds.label) {
        return { action: "replace", deleteFirst: news.label !== undefined } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const label = news.label ?? output?.label ?? (yield* physicalName(id));
      const byId = output === undefined ? Option.none() : yield* observeById(output.namespaceId);
      const observed = Option.isSome(byId)
        ? byId
        : news.label === undefined
          ? yield* observeByLabel(label)
          : Option.none<NamespaceInfo>();
      if (Option.isSome(observed)) return toAttrs(observed.value);
      const { namespace } = yield* DO.createFunctionNamespace({ label, region: news.region });
      return toAttrs(namespace);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteFunctionNamespace({ namespace_id: output.namespaceId }));
    }),
  });
