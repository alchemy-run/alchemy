import * as Data from "@distilled.cloud/mux/data";
import * as MuxRetry from "@distilled.cloud/mux/Retry";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Providers } from "../Providers.ts";

export interface AnnotationProps {
  /**
   * Text shown on Mux Data charts, e.g. `Deployed ${gitSha}`. Changing it
   * creates a new annotation.
   */
  note: string;
  /**
   * Unix seconds the marker sits at. Changing it creates a new annotation.
   * Mux answers dates far in the past (years back) with a server error.
   * @default the moment the annotation is created
   */
  date?: number;
  /**
   * Scope the marker to one Mux Data sub-property. Changing it creates a new
   * annotation.
   */
  sub_property_id?: string;
}

export interface AnnotationAttributes {
  /** Mux annotation ID. */
  id: string;
  /** Text shown on Mux Data charts. */
  note: string;
  /** ISO 8601 time the marker sits at. */
  date: string;
  /** Sub-property the marker is scoped to. */
  sub_property_id: string | undefined;
}

export type Annotation = Resource<
  "Mux.Data.Annotation",
  AnnotationProps,
  AnnotationAttributes,
  never,
  Providers
>;

/**
 * A Mux Data annotation: a marker on Mux Data charts, so a change in
 * rebuffering or startup time can be lined up with what shipped.
 *
 * An annotation marks a moment, so changing any prop creates a new one and
 * deletes the old one. Add `RemovalPolicy.retain()` to keep each old marker
 * as release history. `alchemy deploy --detect-drift` puts back a note
 * edited in the dashboard, and a date too when `date` is set.
 *
 * :::caution
 * Mux refuses to create an annotation with the note and date of one that
 * was deleted (it answers `400 Missing required fields`). An annotation with
 * a pinned `date` therefore cannot be recreated after it is destroyed or
 * replaced; change its note or date to deploy it again.
 * :::
 * @see https://www.mux.com/docs/guides/annotations
 *
 * ### Creating an Annotation
 * **Example:** Mark every release on Mux Data
 * ```typescript
 * const marker = yield* Mux.Data.Annotation("Release", {
 *   note: `Deployed ${process.env.GIT_SHA}`,
 * });
 * ```
 *
 * **Example:** Pin a marker to a moment and a sub-property
 * ```typescript
 * const marker = yield* Mux.Data.Annotation("Launch", {
 *   note: "Public launch",
 *   date: 1767225600,
 *   sub_property_id: "web",
 * });
 * ```
 *
 * ### Keeping release history
 * :::caution
 * Changing `note`, `date` or `sub_property_id` replaces the annotation,
 * deleting the old marker unless it is retained.
 * :::
 *
 * **Example:** Keep every old marker when the note changes
 * ```typescript
 * const marker = yield* Mux.Data.Annotation("Release", {
 *   note: `Deployed ${process.env.GIT_SHA}`,
 * }).pipe(RemovalPolicy.retain());
 * ```
 *
 * @resource
 */
export const Annotation = Resource<Annotation>("Mux.Data.Annotation");

const toAttrs = (annotation: Data.Annotation): AnnotationAttributes => ({
  id: annotation.id,
  note: annotation.note,
  date: annotation.date,
  sub_property_id: annotation.sub_property_id ?? undefined,
});

const unixSeconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export const AnnotationProvider = () =>
  Provider.effect(
    Annotation,
    Effect.gen(function* () {
      const create = yield* Data.createAnnotation;
      const update = yield* Data.updateAnnotation;
      const get = yield* Data.getAnnotation;
      const del = yield* Data.deleteAnnotation;
      const list = yield* Data.listAnnotations;

      const observe = (id: string) =>
        get({ ANNOTATION_ID: id }).pipe(
          Effect.map((res) => toAttrs(res.data)),
          Effect.catchTag("NotFound", () => Effect.undefined),
        );

      return {
        stables: ["id"],
        list: () =>
          list.items({ limit: 100 }).pipe(
            Stream.runCollect,
            Effect.map((annotations) => annotations.map(toAttrs)),
          ),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (output === undefined) return undefined;
          if (!isResolved(news)) return { action: "replace" } as const;
          return deepEqual(olds, news) ? undefined : ({ action: "replace" } as const);
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const observed = output?.id ? yield* observe(output.id) : undefined;

          if (observed === undefined) {
            const now = yield* Clock.currentTimeMillis;
            // A create that failed with a 5xx may still have happened, so it
            // is retried only on throttling.
            const { data } = yield* create({
              note: news.note,
              date: news.date ?? Math.floor(now / 1000),
              sub_property_id: news.sub_property_id,
            }).pipe(MuxRetry.throttling);
            return toAttrs(data);
          }

          // Any prop change replaces, so this runs for drift repair and
          // adoption: put back a note, date or sub-property edited on Mux.
          const date = news.date ?? unixSeconds(observed.date);
          if (
            observed.note === news.note &&
            (observed.sub_property_id ?? undefined) === news.sub_property_id &&
            unixSeconds(observed.date) === date
          ) {
            return observed;
          }
          const { data } = yield* update({
            ANNOTATION_ID: observed.id,
            note: news.note,
            date,
            // Mux clears a sub-property sent as "", so one added on Mux goes.
            sub_property_id: news.sub_property_id ?? "",
          });
          return toAttrs(data);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ ANNOTATION_ID: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return yield* observe(output.id);
        }),
      };
    }),
  );
