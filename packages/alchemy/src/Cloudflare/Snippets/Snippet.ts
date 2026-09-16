import * as snippets from "@distilled.cloud/cloudflare/snippets";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

export interface SnippetProps {
  /**
   * Zone the snippet belongs to. Stable — changing the zone triggers
   * replacement.
   */
  zoneId: string;
  /**
   * Name of the snippet. Snippet names may only contain letters, numbers,
   * and underscores (`[a-zA-Z0-9_]`) — the name is the snippet's identity
   * within the zone, so changing it triggers replacement.
   *
   * If omitted, a unique name is generated from the app, stage, and
   * logical ID.
   *
   * @default ${app}_${id}_${stage}_${suffix}
   */
  name?: string;
  /**
   * JavaScript source code of the snippet (ES module). Snippets are
   * lightweight Workers-like scripts with hard platform limits: no
   * environment variables or bindings, 5ms CPU time, 2MB memory, and a
   * 32KB compressed size limit (500KB on Enterprise).
   *
   * Mutable — updated in place via upload.
   */
  code?: string;
  /** Additional upload modules. Include the main module here when omitting code. */
  files?: SnippetFile[];
  /**
   * Filename of the snippet's main module as referenced in the upload.
   *
   * @default "snippet.js"
   */
  mainModule?: string;
}

/** A named text or binary module in a Snippet multipart upload. */
export interface SnippetFile {
  /** Module filename used by import statements. */
  name: string;
  /** UTF-8 source text or binary module bytes. */
  content: string | Uint8Array;
  /** MIME type identifying the module; defaults to application/javascript+module. */
  contentType?: string;
}

export interface SnippetAttributes {
  /** Name identifying the snippet within the zone. */
  name: string;
  /** Zone that owns this snippet. */
  zoneId: string;
  /** Filename of the snippet's main module. */
  mainModule: string;
  /** ISO8601 creation timestamp. */
  createdOn: string | undefined;
  /** ISO8601 last-modified timestamp. */
  modifiedOn: string | undefined;
}

export type Snippet = Resource<
  "Cloudflare.Snippets.Snippet",
  SnippetProps,
  SnippetAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Snippet — a lightweight JavaScript module that runs on
 * Cloudflare's edge to modify HTTP traffic for a zone.
 *
 * Uploading a snippet does not activate it: traffic only flows through a
 * snippet once a {@link SnippetRules} rule references it with a matching
 * expression.
 *
 * Safety: snippets carry no ownership markers. When there is no prior
 * state, `read` looks the snippet up by name and reports an existing match
 * as `Unowned`, so the engine refuses to take it over unless `--adopt`
 * (or `adopt(true)`) is set.
 * ### Creating a Snippet
 * **Example:** Add a response header
 * ```typescript
 * const snippet = yield* Cloudflare.Snippets.Snippet("HeaderSnippet", {
 *   zoneId: zone.zoneId,
 *   code: `
 *     export default {
 *       async fetch(request) {
 *         const response = await fetch(request);
 *         const headers = new Headers(response.headers);
 *         headers.set("x-snippet", "hello");
 *         return new Response(response.body, { ...response, headers });
 *       },
 *     };
 *   `,
 * });
 * ```
 *
 * ### Uploading Multiple Modules
 * **Example:** Import a helper module
 * ```typescript
 * yield* Cloudflare.Snippets.Snippet("Modules", {
 *   zoneId: zone.zoneId,
 *   mainModule: "main.js",
 *   files: [
 *     { name: "main.js", content: 'import handler from "./helper.js"; export default handler;' },
 *     { name: "helper.js", content: 'export default { fetch(request) { return fetch(request); } };' },
 *   ],
 * });
 * ```
 *
 * ### Activating with Snippet Rules
 * **Example:** Route traffic through the snippet
 * ```typescript
 * yield* Cloudflare.Snippets.SnippetRules("Rules", {
 *   zoneId: zone.zoneId,
 *   rules: [
 *     {
 *       snippetName: snippet.name,
 *       expression: 'http.request.uri.path wildcard "/api/*"',
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product Snippets
 * @category Rules & Configuration
 */
export const Snippet = Resource<Snippet>("Cloudflare.Snippets.Snippet");

export const isSnippet = (value: unknown): value is Snippet =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === "Cloudflare.Snippets.Snippet";

const DEFAULT_MAIN_MODULE = "snippet.js";

export const SnippetProvider = () =>
  Provider.succeed(Snippet, {
    stables: ["name", "zoneId", "createdOn"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Snippets live inside a zone with no account-wide enumeration
      // API — fan out across every zone and list snippets per zone.
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          snippets.listSnippets.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map((s): SnippetAttributes => ({
                  name: s.snippetName,
                  zoneId: zone.id,
                  // The list response carries no main module; snippets
                  // upload under the engine default and `read` falls
                  // back to it too, so report the same here.
                  mainModule: DEFAULT_MAIN_MODULE,
                  createdOn: s.createdOn,
                  modifiedOn: s.modifiedOn ?? undefined,
                })),
              ),
            ),
            // Plan-gated / partial-permission zones reject the route; skip.
            Effect.catchTag("Forbidden", () =>
              Effect.succeed([] as SnippetAttributes[]),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ id, olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const o = olds as SnippetProps;
      const n = news as SnippetProps;

      // Name is the snippet's identity within the zone.
      const oldName =
        output?.name ?? (yield* createSnippetName(id, o.name as string));
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const name = n.name ?? oldName;
      if (oldName !== name) {
        return { action: "replace" } as const;
      }
      // zoneId is Input<string>; only compare once both are concrete.
      const oldZoneId =
        output?.zoneId ?? (typeof o.zoneId === "string" ? o.zoneId : undefined);
      if (
        typeof n.zoneId === "string" &&
        oldZoneId !== undefined &&
        oldZoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      // Owned path: refresh from persisted identity.
      if (output?.name && output.zoneId) {
        const observed = yield* getSnippetOrUndefined(
          output.zoneId,
          output.name,
        );
        if (observed) {
          return toAttributes(observed, output.zoneId, output.mainModule);
        }
        return undefined;
      }
      // Cold read: derive the deterministic name and look it up. Snippets
      // carry no ownership markers, so an existing match is `Unowned` and
      // takeover is gated behind the adopt policy.
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (!zoneId) return undefined;
      const name = output?.name ?? (yield* createSnippetName(id, olds?.name));
      const observed = yield* getSnippetOrUndefined(zoneId, name);
      if (observed) {
        return Unowned(
          toAttributes(
            observed,
            zoneId,
            olds?.mainModule ?? DEFAULT_MAIN_MODULE,
          ),
        );
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      // Inputs have been resolved to concrete values by Plan.
      const zoneId = (output?.zoneId ?? news.zoneId) as string;
      const name = output?.name ?? (yield* createSnippetName(id, news.name));
      const mainModule = news.mainModule ?? DEFAULT_MAIN_MODULE;

      const modules: SnippetFile[] = [...(news.files ?? [])];
      if (news.code !== undefined)
        modules.push({ name: mainModule, content: news.code });
      if (new Set(modules.map((file) => file.name)).size !== modules.length)
        return yield* Effect.fail(
          new Error(
            "Snippet module filenames must be unique; do not specify the main module in both code and files",
          ),
        );
      if (!modules.some((file) => file.name === mainModule))
        return yield* Effect.fail(
          new Error(
            `Snippet main module ${mainModule} must be supplied by code or files`,
          ),
        );
      const observed = yield* getSnippetOrUndefined(zoneId, name);
      // The download API does not expose metadata identifying the entrypoint.
      // Binary multipart downloads are decoded as text by the upstream API
      // schema, so only skip uploads when every desired module is textual.
      if (
        observed &&
        output?.mainModule === mainModule &&
        modules.every((file) => typeof file.content === "string")
      ) {
        const content = yield* snippets
          .getContent({ zoneId, snippetName: name })
          .pipe(
            Effect.catchTag("SnippetNotFound", () => Effect.succeed(undefined)),
          );
        if (content?.contentType?.startsWith("multipart/form-data")) {
          const files = yield* Effect.tryPromise(() =>
            new Response(content.body, {
              headers: { "Content-Type": content.contentType! },
            }).formData(),
          );
          const entries = [...files.entries()];
          let equal = entries.length === modules.length;
          for (const module of modules) {
            const file: unknown = files.get(module.name);
            if (
              !(file instanceof Blob) ||
              !("name" in file) ||
              file.name !== module.name ||
              normalizeModuleType(file.type) !==
                normalizeModuleType(
                  module.contentType ?? "application/javascript+module",
                ) ||
              (yield* Effect.tryPromise(() => file.text())) !== module.content
            ) {
              equal = false;
              break;
            }
          }
          if (equal) return toAttributes(observed, zoneId, mainModule);
        }
      }
      // PUT ensures missing content and restores drift in existing modules.
      const files = modules.map(
        (module) =>
          new File(
            [
              typeof module.content === "string"
                ? module.content
                : new Uint8Array(module.content).buffer,
            ],
            module.name,
            { type: module.contentType ?? "application/javascript+module" },
          ),
      );
      const synced = yield* snippets.putSnippet({
        zoneId,
        snippetName: name,
        metadata: { mainModule },
        files,
      });

      return toAttributes(synced, zoneId, mainModule);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* snippets
        .deleteSnippet({
          zoneId: output.zoneId,
          snippetName: output.name,
        })
        // A snippet can only be deleted once no snippet rule references it.
        // The engine deletes referencing `SnippetRules` first (dependency
        // edge via `snippetName`), but the rule removal is eventually
        // consistent — Cloudflare may still report `snippet is still used`
        // for a short window. Bounded-retry that lag before giving up.
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "SnippetInUse",
            schedule: Schedule.max([
              Schedule.min([
                Schedule.exponential("1 second"),
                Schedule.spaced("5 seconds"),
              ]),
              Schedule.recurs(8),
            ]),
          }),
          Effect.catchTag("SnippetNotFound", () => Effect.void),
        );
    }),
  });

/**
 * Snippet names only allow letters, numbers, and underscores; physical
 * names are generated with `_` separators and any residual hyphens (from
 * the app/stage/id) are normalized to underscores.
 */
const createSnippetName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    const physical = yield* createPhysicalName({
      id,
      lowercase: true,
      delimiter: "_",
    });
    return physical.replaceAll("-", "_");
  });

const getSnippetOrUndefined = (zoneId: string, snippetName: string) =>
  snippets
    .getSnippet({ zoneId, snippetName })
    .pipe(Effect.catchTag("SnippetNotFound", () => Effect.succeed(undefined)));

const toAttributes = (
  observed: snippets.GetSnippetResponse,
  zoneId: string,
  mainModule: string,
): SnippetAttributes => ({
  name: observed.snippetName,
  zoneId,
  mainModule,
  createdOn: observed.createdOn,
  modifiedOn: observed.modifiedOn ?? undefined,
});

// Cloudflare downloads JavaScript modules as text/javascript;charset=utf-8.
const normalizeModuleType = (type: string) => {
  const mime = type.split(";")[0]!.toLowerCase();
  return [
    "text/javascript",
    "application/javascript",
    "application/javascript+module",
  ].includes(mime)
    ? "javascript"
    : mime;
};
