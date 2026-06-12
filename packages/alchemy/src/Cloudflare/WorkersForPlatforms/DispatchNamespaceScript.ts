import * as wfp from "@distilled.cloud/cloudflare/workers-for-platforms";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const DispatchNamespaceScriptTypeId =
  "Cloudflare.Workers.DispatchNamespaceScript" as const;
type DispatchNamespaceScriptTypeId = typeof DispatchNamespaceScriptTypeId;

export interface DispatchNamespaceScriptProps {
  /**
   * Name of the dispatch namespace the script is uploaded into (e.g.
   * `namespace.name` of a {@link DispatchNamespace}). Changing the
   * namespace triggers a replacement.
   */
  namespace: string;
  /**
   * Name of the script within the namespace. The name is the script's
   * identity — changing it triggers a replacement. If omitted, a unique
   * name is generated from the app, stage, and logical ID.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  scriptName?: string;
  /**
   * Inline ES module source for the user Worker (uploaded as the main
   * module). Mutable — re-uploaded in place on change.
   */
  script: string;
  /**
   * Compatibility date for the Worker runtime (e.g. `"2024-01-01"`).
   * Mutable.
   */
  compatibilityDate?: string;
  /**
   * Compatibility flags for the Worker runtime. Mutable.
   */
  compatibilityFlags?: string[];
  /**
   * Per-script tags, typically used by platforms to associate user Workers
   * with a customer for bulk cleanup. Mutable.
   */
  tags?: string[];
}

export interface DispatchNamespaceScriptAttributes {
  /**
   * Name of the script (its identity within the namespace).
   */
  scriptName: string;
  /**
   * Name of the dispatch namespace the script lives in.
   */
  namespace: string;
  /**
   * The Cloudflare account the script belongs to.
   */
  accountId: string;
  /**
   * Hashed script content used by the API for version comparison.
   */
  etag: string | undefined;
  /**
   * When the script was created.
   */
  createdOn: string | undefined;
  /**
   * When the script was last modified.
   */
  modifiedOn: string | undefined;
}

export type DispatchNamespaceScript = Resource<
  DispatchNamespaceScriptTypeId,
  DispatchNamespaceScriptProps,
  DispatchNamespaceScriptAttributes,
  never,
  Providers
>;

/**
 * A user Worker uploaded into a Workers for Platforms dispatch namespace.
 *
 * Dispatch namespace scripts are the per-customer Workers that a platform
 * Worker invokes at runtime through a `dispatch_namespace` binding
 * (`env.DISPATCH.get(scriptName)`). The upload API is a true upsert, so
 * reconcile simply re-uploads the desired module; `namespace` and
 * `scriptName` form the script's identity and changing either triggers a
 * replacement.
 *
 * This resource supports small inline ES modules. For full bundling,
 * assets, and rich binding support, see the follow-up notes in the
 * Workers for Platforms catalog.
 *
 * @section Uploading a script
 * @example Inline user Worker
 * ```typescript
 * const namespace = yield* Cloudflare.DispatchNamespace("Customers", {});
 *
 * const script = yield* Cloudflare.DispatchNamespaceScript("CustomerA", {
 *   namespace: namespace.name,
 *   script: `export default { fetch() { return new Response("hello"); } }`,
 * });
 * ```
 *
 * @example With compatibility date and customer tags
 * ```typescript
 * yield* Cloudflare.DispatchNamespaceScript("CustomerB", {
 *   namespace: namespace.name,
 *   scriptName: "customer-b",
 *   script: `export default { fetch() { return new Response("hi"); } }`,
 *   compatibilityDate: "2024-09-23",
 *   tags: ["customer-b"],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/
 */
export const DispatchNamespaceScript = Resource<DispatchNamespaceScript>(
  DispatchNamespaceScriptTypeId,
);

/**
 * Returns true if the given value is a DispatchNamespaceScript resource.
 */
export const isDispatchNamespaceScript = (
  value: unknown,
): value is DispatchNamespaceScript =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === DispatchNamespaceScriptTypeId;

const MAIN_MODULE = "index.mjs";

export const DispatchNamespaceScriptProvider = () =>
  Provider.succeed(DispatchNamespaceScript, {
    stables: ["scriptName", "namespace", "accountId", "createdOn"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // (namespace, scriptName) is the script's identity.
      const oldNamespace = output?.namespace ?? olds?.namespace;
      if (
        typeof oldNamespace === "string" &&
        typeof news.namespace === "string" &&
        oldNamespace !== news.namespace
      ) {
        return { action: "replace" } as const;
      }
      const oldName = output?.scriptName ?? olds?.scriptName;
      const newName = news.scriptName ?? olds?.scriptName ?? oldName;
      if (oldName !== undefined && oldName !== newName) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const namespace =
        output?.namespace ?? (olds?.namespace as string | undefined);
      if (namespace === undefined) return undefined;
      // (namespace, scriptName) is the identity — a cold read lands on the
      // same deterministic name as reconcile would.
      const scriptName =
        output?.scriptName ??
        olds?.scriptName ??
        (yield* createPhysicalName({ id, lowercase: true }));
      const observed = yield* getScript(acct, namespace, scriptName);
      return observed
        ? toAttributes(observed, acct, namespace, scriptName)
        : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Inputs have been resolved to concrete strings by Plan.
      const namespace = news.namespace as string;
      const scriptName =
        news.scriptName ?? (yield* createPhysicalName({ id, lowercase: true }));

      // The upload API is a true upsert: one PUT both creates and updates,
      // and it is idempotent — so observe/ensure/sync collapse into a
      // single delegated call (same shape as the Worker provider).
      const mainModule = yield* Effect.sync(
        () =>
          new File([news.script], MAIN_MODULE, {
            type: "application/javascript+module",
          }),
      );
      const uploaded = yield* wfp.putDispatchNamespaceScript({
        accountId,
        dispatchNamespace: namespace,
        scriptName,
        metadata: {
          mainModule: MAIN_MODULE,
          compatibilityDate: news.compatibilityDate,
          compatibilityFlags: news.compatibilityFlags,
          tags: news.tags,
        },
        files: [mainModule],
      });
      return {
        scriptName: uploaded.id ?? scriptName,
        namespace,
        accountId,
        etag: uploaded.etag ?? undefined,
        createdOn: uploaded.createdOn ?? undefined,
        modifiedOn: uploaded.modifiedOn ?? undefined,
      } satisfies DispatchNamespaceScriptAttributes;
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* wfp
        .deleteDispatchNamespaceScript({
          accountId: output.accountId,
          dispatchNamespace: output.namespace,
          scriptName: output.scriptName,
          force: true,
        })
        .pipe(
          // Idempotent: the script may already be gone, or the whole
          // namespace may have been deleted (which removes its scripts).
          Effect.catchTag(
            ["DispatchNamespaceScriptNotFound", "DispatchNamespaceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });

type ObservedScript = NonNullable<
  wfp.GetDispatchNamespaceScriptResponse["script"]
> & {
  createdOn?: string | null;
  modifiedOn?: string | null;
};

/**
 * Read a script by `(namespace, scriptName)`, mapping "gone" to
 * `undefined`. A missing script in an existing namespace comes back as a
 * success with `script: null`; a missing namespace surfaces as
 * `DispatchNamespaceNotFound` (code 100119).
 */
const getScript = (accountId: string, namespace: string, scriptName: string) =>
  wfp
    .getDispatchNamespaceScript({
      accountId,
      dispatchNamespace: namespace,
      scriptName,
    })
    .pipe(
      Effect.map((response) =>
        response.script
          ? {
              ...response.script,
              createdOn: response.script.createdOn ?? response.createdOn,
              modifiedOn: response.script.modifiedOn ?? response.modifiedOn,
            }
          : undefined,
      ),
      Effect.catchTag(
        ["DispatchNamespaceNotFound", "DispatchNamespaceScriptNotFound"],
        () => Effect.succeed(undefined),
      ),
    );

const toAttributes = (
  script: ObservedScript,
  accountId: string,
  namespace: string,
  scriptName: string,
): DispatchNamespaceScriptAttributes => ({
  scriptName: script.id ?? scriptName,
  namespace,
  accountId,
  etag: script.etag ?? undefined,
  createdOn: script.createdOn ?? undefined,
  modifiedOn: script.modifiedOn ?? undefined,
});
