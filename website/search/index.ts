import { createHash } from "node:crypto";
import * as ai from "@distilled.cloud/cloudflare/ai";
import type { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../src/docs-search.ts";
import { extractSections, type DocSection } from "./extract.ts";

/**
 * Docs search storage. Every section of every page is one row in each:
 *
 * - `DocsVectors` holds its embedding (semantic search), with `provider` as
 *   filterable metadata.
 * - `DocsText` holds its text in an FTS5 table (keyword search).
 *
 * Both are filled by {@link IndexDocs} at deploy time — no crawler.
 */
export const DocsVectors = Cloudflare.Vectorize.Index("DocsSearchVectors", {
  dimensions: EMBEDDING_DIMENSIONS,
  metric: "cosine",
});

export const DocsText = Cloudflare.D1.Database("DocsSearchText", {
  migrations: "./search/migrations",
});

/** Lets a query filter vectors by provider; must exist before vectors are written. */
export const DocsProviderIndex = Effect.flatMap(DocsVectors, (vectors) =>
  Cloudflare.Vectorize.MetadataIndex("DocsSearchProvider", {
    indexName: vectors.indexName,
    propertyName: "provider",
    indexType: "string",
  }),
);

/**
 * Workers AI takes at most 32 documents per embedding call, and rejects a
 * call whose total input is too large ("input too big").
 */
const EMBED_BATCH = 32;
const EMBED_BATCH_CHARS = 24_000;
/** Embedding calls in flight; each takes ~1–3s. */
const EMBED_CONCURRENCY = 16;
/** Statements per D1 batch — each insert carries a whole section body. */
const WRITE_BATCH = 25;

/**
 * Index the built site into {@link DocsVectors} and {@link DocsText}.
 *
 * Reads every rendered page in `dist/`, splits it into sections at its
 * h2/h3 headings, and re-embeds only sections whose text changed since the
 * last run (each row stores a hash of its text); sections that disappeared
 * are deleted. Pass the Website's asset hash as input so the Action runs
 * only on deploys that change the site.
 */
export const IndexDocs = Alchemy.Action(
  "IndexDocs",
  Effect.gen(function* () {
    const vectors = yield* Cloudflare.Vectorize.SearchIndex(yield* DocsVectors);
    const db = yield* Cloudflare.D1.QueryDatabase(yield* DocsText);
    // Captured so vectors are only written once the metadata index exists.
    const providerIndex = yield* (yield* DocsProviderIndex).propertyName;
    // Workers AI has no deploy-time binding layer: call its HTTP API with the
    // credentials Alchemy is deploying with.
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const cloudflare = yield* Effect.context<Credentials | HttpClient.HttpClient>();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dist = yield* path.fromFileUrl(new URL("../dist/", import.meta.url));

    /** Embed a batch, halving it whenever Workers AI rejects it as too big. */
    const embed = (batch: DocSection[]): Effect.Effect<number[][], ai.RunAiError | Error> =>
      ai.runAi({ accountId, modelName: EMBEDDING_MODEL, text: batch.map(embeddingText) }).pipe(
        Effect.provideContext(cloudflare),
        Effect.flatMap((result) => {
          const data = (result as { data?: number[][] }).data;
          return data?.length === batch.length
            ? Effect.succeed(data)
            : Effect.fail(
                new Error(
                  `${EMBEDDING_MODEL} returned ${data?.length} embeddings for ${batch.length} sections`,
                ),
              );
        }),
        Effect.catchTag("InputTooBig", (error) =>
          batch.length === 1
            ? Effect.fail(error)
            : Effect.map(
                Effect.all([
                  embed(batch.slice(0, batch.length / 2)),
                  embed(batch.slice(batch.length / 2)),
                ]),
                ([a, b]) => [...a, ...b],
              ),
        ),
      );

    return Effect.fn(function* (_input: { assets: string | undefined }) {
      yield* providerIndex;

      const files = (yield* fs.readDirectory(dist, { recursive: true })).filter(
        (file) => path.basename(file) === "index.html",
      );
      const pages = yield* Effect.forEach(
        files,
        (file) =>
          Effect.map(fs.readFileString(path.join(dist, file)), (html) => {
            const dir = path.dirname(file).split(path.sep).join("/");
            return extractSections(dir === "." ? "/" : `/${dir}/`, html);
          }),
        { concurrency: 32 },
      );
      const sections = yield* Effect.sync(() =>
        pages.flat().map((section) => ({ ...section, ...identify(section) })),
      );

      const existing = new Map(
        (
          (yield* db.prepare("SELECT id, hash FROM sections").all<{ id: string; hash: string }>())
            .results ?? []
        ).map((row) => [row.id, row.hash]),
      );
      const current = new Set(sections.map((section) => section.id));
      const changed = sections.filter((section) => existing.get(section.id) !== section.hash);
      const removed = [...existing.keys()].filter((id) => !current.has(id));

      yield* Effect.log(
        `docs search: ${sections.length} sections, ${changed.length} to embed, ${removed.length} to delete`,
      );

      yield* Effect.forEach(
        embedBatches(changed),
        (batch) =>
          Effect.gen(function* () {
            const embeddings = yield* embed(batch);
            yield* vectors.upsert(
              batch.map((section, i) => ({
                id: section.id,
                values: embeddings[i]!,
                metadata: { provider: section.provider },
              })),
            );
            yield* Effect.forEach(chunk(batch, WRITE_BATCH), (rows) =>
              db.batch(
                rows.flatMap((row) => [
                  ...(existing.has(row.id)
                    ? [db.prepare("DELETE FROM sections WHERE id = ?").bind(row.id)]
                    : []),
                  db
                    .prepare(
                      "INSERT INTO sections (id, hash, path, anchor, provider, section, title, heading, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(
                      row.id,
                      row.hash,
                      row.path,
                      row.anchor,
                      row.provider,
                      row.section,
                      row.title,
                      row.heading ?? "",
                      row.body,
                    ),
                ]),
              ),
            );
          }),
        { concurrency: EMBED_CONCURRENCY, discard: true },
      );

      yield* Effect.forEach(
        chunk(removed, 100),
        (ids) =>
          Effect.gen(function* () {
            yield* vectors.deleteByIds(ids);
            yield* db.batch(
              ids.map((id) => db.prepare("DELETE FROM sections WHERE id = ?").bind(id)),
            );
          }),
        { discard: true },
      );

      return { sections: sections.length, embedded: changed.length, deleted: removed.length };
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.Vectorize.SearchIndexLocal, Cloudflare.D1.QueryDatabaseLocal),
    ),
  ),
);

/** What gets embedded: the section's place in the docs, then its text. */
const embeddingText = (section: DocSection) =>
  [`${section.title}${section.heading ? ` › ${section.heading}` : ""}`, section.body]
    .join("\n\n")
    // A section's start says what it's about (and its tail is mostly code);
    // keyword search still covers the full body.
    .slice(0, 2_500);

/**
 * Stable id per (page, anchor) — Vectorize ids max out at 64 bytes — and a
 * hash of everything stored, so an unchanged section is never re-embedded.
 */
const identify = (section: DocSection) => ({
  id: createHash("sha256").update(`${section.path}#${section.anchor}`).digest("hex").slice(0, 32),
  hash: createHash("sha256")
    .update(
      JSON.stringify([EMBEDDING_MODEL, section.provider, section.section, embeddingText(section)]),
    )
    .digest("hex"),
});

/** Pack sections into embedding calls under both the count and size limits. */
const embedBatches = <S extends DocSection>(sections: S[]): S[][] => {
  const batches: S[][] = [];
  let batch: S[] = [];
  let chars = 0;
  for (const section of sections) {
    const size = embeddingText(section).length;
    if (batch.length === EMBED_BATCH || (batch.length > 0 && chars + size > EMBED_BATCH_CHARS)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(section);
    chars += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
};

const chunk = <A>(items: A[], size: number): A[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );
