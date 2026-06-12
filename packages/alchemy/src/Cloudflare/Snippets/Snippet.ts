import * as snippets from "@distilled.cloud/cloudflare/snippets";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

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
  code: string;
  /**
   * Filename of the snippet's main module as referenced in the upload.
   *
   * @default "snippet.js"
   */
  mainModule?: string;
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
 *
 * @section Creating a Snippet
 * @example Add a response header
 * ```typescript
 * const snippet = yield* Cloudflare.Snippet("HeaderSnippet", {
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
 * @section Activating with Snippet Rules
 * @example Route traffic through the snippet
 * ```typescript
 * yield* Cloudflare.SnippetRules("Rules", {
 *   zoneId: zone.zoneId,
 *   rules: [
 *     {
 *       snippetName: snippet.name,
 *       expression: 'http.request.uri.path wildcard "/api/*"',
 *     },
 *   ],
 * });
 * ```
 */
export const Snippet = Resource<Snippet>("Cloudflare.Snippets.Snippet");

export const isSnippet = (value: unknown): value is Snippet =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === "Cloudflare.Snippets.Snippet";

const DEFAULT_MAIN_MODULE = "snippet.js";

export const SnippetProvider = () =>
  Provider.succeed(Snippet, {
    stables: ["name", "zoneId", "createdOn"],

    diff: Effect.fn(function* ({ id, olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const o = olds as SnippetProps;
      const n = news as SnippetProps;

      // Name is the snippet's identity within the zone.
      const name = yield* createSnippetName(id, n.name);
      const oldName =
        output?.name ?? (yield* createSnippetName(id, o.name as string));
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

      // `putSnippet` (PUT) is a true upsert — one call converges greenfield
      // create, routine update, and adoption alike.
      const file = yield* Effect.sync(
        () =>
          new File([news.code], mainModule, {
            type: "application/javascript+module",
          }),
      );
      const synced = yield* snippets.putSnippet({
        zoneId,
        snippetName: name,
        metadata: { mainModule },
        files: file,
      });

      return toAttributes(synced, zoneId, mainModule);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* snippets
        .deleteSnippet({
          zoneId: output.zoneId,
          snippetName: output.name,
        })
        .pipe(Effect.catchTag("SnippetNotFound", () => Effect.void));
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
