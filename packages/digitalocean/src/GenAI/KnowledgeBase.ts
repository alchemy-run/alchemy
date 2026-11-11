import * as DO from "@distilled.cloud/digitalocean";
import type { ApiKnowledgeBase, ApiKnowledgeBaseDataSource } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";
import { resolveModel } from "./Agent.ts";

/** One place a knowledge base indexes content from. */
export type KnowledgeBaseSource =
  | {
      /** Index the objects in a Spaces bucket. */
      spaces: {
        /** Bucket name. */
        bucketName: string;
        /** Bucket region, for example `"nyc3"`. */
        region: string;
        /** Index only objects under this path. */
        itemPath?: string;
      };
    }
  | {
      /** Crawl a website and index its pages. */
      webCrawler: {
        /** The URL the crawl starts from. */
        baseUrl: string;
        /**
         * How far the crawl follows links: `SCOPED` (the one page), `PATH`
         * (pages under the URL's path), `DOMAIN`, `SUBDOMAINS`, or `SITEMAP`.
         *
         * @default "SCOPED"
         */
        crawlingOption?: "SCOPED" | "PATH" | "DOMAIN" | "SUBDOMAINS" | "SITEMAP";
        /** Also index images and other media. @default false */
        embedMedia?: boolean;
      };
    };

export type KnowledgeBaseProps = {
  /**
   * Knowledge base name. A change renames it in place.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Project the knowledge base belongs to. Updates in place. */
  projectId: string;
  /**
   * The embedding model, by UUID or catalog name (for example
   * `"GTE Large EN v1.5"`). A change replaces the knowledge base.
   */
  embeddingModel: string;
  /** Region. A change replaces the knowledge base. @default "tor1" */
  region?: string;
  /**
   * An existing OpenSearch database cluster to store the index in. When
   * omitted, DigitalOcean provisions one, and Alchemy destroys it with the
   * knowledge base. A change replaces the knowledge base.
   */
  databaseId?: string;
  /**
   * Where the content comes from. Sources are added and removed in place;
   * new sources are indexed when they are added.
   */
  sources: KnowledgeBaseSource[];
  /** Tags. Updates in place. */
  tags?: string[];
};

export type KnowledgeBase = Resource<
  "DigitalOcean.GenAI.KnowledgeBase",
  KnowledgeBaseProps,
  {
    /** Knowledge base UUID. */
    knowledgeBaseId: string;
    /** Knowledge base name. */
    name: string;
    /** The OpenSearch database cluster that stores the index. */
    databaseId: string | undefined;
    /** Whether DigitalOcean provisioned the database for this knowledge base. */
    ownsDatabase: boolean;
    /** ISO 8601 creation time. */
    createdAt: string;
  },
  never,
  Providers
>;

export type KnowledgeBaseAttributes = KnowledgeBase["Attributes"];

/**
 * A DigitalOcean GenAI knowledge base: content from Spaces buckets or
 * crawled websites, embedded and indexed in an OpenSearch database, that
 * agents retrieve from. Attach it to an `Agent` with `knowledgeBaseIds`.
 *
 * Without `databaseId`, DigitalOcean provisions an OpenSearch cluster for
 * the knowledge base, billed while it exists; Alchemy destroys that cluster
 * when it destroys the knowledge base.
 *
 * ### Creating a Knowledge Base
 * **Example:** Index a documentation site
 * ```typescript
 * const docs = yield* DigitalOcean.GenAI.KnowledgeBase("docs", {
 *   projectId: project.projectId,
 *   embeddingModel: "GTE Large EN v1.5",
 *   sources: [
 *     { webCrawler: { baseUrl: "https://docs.example.com", crawlingOption: "PATH" } },
 *   ],
 * });
 * ```
 *
 * **Example:** Index the files in a Spaces bucket
 * ```typescript
 * const files = yield* DigitalOcean.Spaces.Bucket("files", { region: "nyc3" });
 * const kb = yield* DigitalOcean.GenAI.KnowledgeBase("files", {
 *   projectId: project.projectId,
 *   embeddingModel: "GTE Large EN v1.5",
 *   sources: [{ spaces: { bucketName: files.bucketName, region: "nyc3" } }],
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/products/genai-platform/how-to/create-manage-agent-knowledge-bases/
 *
 * @resource
 * @product GenAI Platform
 * @category AI
 */
export const KnowledgeBase = Resource<KnowledgeBase>("DigitalOcean.GenAI.KnowledgeBase");

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const toWire = (source: KnowledgeBaseSource) =>
  "spaces" in source
    ? {
        spaces_data_source: {
          bucket_name: source.spaces.bucketName,
          region: source.spaces.region,
          item_path: source.spaces.itemPath,
        },
      }
    : {
        web_crawler_data_source: {
          base_url: source.webCrawler.baseUrl,
          crawling_option: source.webCrawler.crawlingOption ?? "SCOPED",
          embed_media: source.webCrawler.embedMedia ?? false,
        },
      };

// A source's identity is what it reads from; its options are part of it.
const keyOfSource = (source: KnowledgeBaseSource) =>
  "spaces" in source
    ? `spaces:${source.spaces.region}/${source.spaces.bucketName}/${source.spaces.itemPath ?? ""}`
    : `web:${source.webCrawler.baseUrl}|${source.webCrawler.crawlingOption ?? "SCOPED"}|${source.webCrawler.embedMedia ?? false}`;

const keyOfObserved = (source: ApiKnowledgeBaseDataSource) => {
  const spaces = source.spaces_data_source;
  if (spaces?.bucket_name) {
    return `spaces:${spaces.region ?? ""}/${spaces.bucket_name}/${spaces.item_path ?? ""}`;
  }
  const web = source.web_crawler_data_source;
  if (web?.base_url) {
    return `web:${web.base_url}|${web.crawling_option ?? "SCOPED"}|${web.embed_media ?? false}`;
  }
  return undefined;
};

const toAttrs = (kb: ApiKnowledgeBase, ownsDatabase: boolean): KnowledgeBaseAttributes => ({
  knowledgeBaseId: kb.uuid,
  name: kb.name,
  databaseId: kb.database_id,
  ownsDatabase,
  createdAt: kb.created_at,
});

const observeById = (id: string) =>
  noneIfNotFound(DO.getGenaiKnowledgeBase({ uuid: id }).pipe(Effect.map((r) => r.knowledge_base)));

const observeByName = (name: string) =>
  DO.listGenaiKnowledgeBases.items({ per_page: 200 }).pipe(
    Stream.filter((kb) => kb.name === name),
    Stream.runHead,
  );

const listSources = (knowledgeBaseId: string) =>
  DO.listGenaiKnowledgeBaseDataSources
    .items({ knowledge_base_uuid: knowledgeBaseId, per_page: 200 })
    .pipe(Stream.runCollect);

export const KnowledgeBaseProvider = () =>
  Provider.succeed(KnowledgeBase, {
    stables: ["knowledgeBaseId", "createdAt", "databaseId", "ownsDatabase"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output }) {
      const owns = output?.ownsDatabase ?? olds.databaseId === undefined;
      if (output !== undefined) {
        const byId = yield* observeById(output.knowledgeBaseId);
        if (Option.isSome(byId)) return toAttrs(byId.value, owns);
      }
      if (olds.name !== undefined) return undefined;
      const named = yield* observeByName(yield* physicalName(id));
      return Option.getOrUndefined(Option.map(named, (kb) => toAttrs(kb, owns)));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (
        news.embeddingModel !== olds.embeddingModel ||
        (news.region ?? "tor1") !== (olds.region ?? "tor1") ||
        news.databaseId !== olds.databaseId
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? (yield* physicalName(id));
      const ownsDatabase = output?.ownsDatabase ?? news.databaseId === undefined;
      const byId =
        output === undefined ? Option.none() : yield* observeById(output.knowledgeBaseId);
      const observed = Option.isSome(byId)
        ? byId
        : news.name === undefined
          ? yield* observeByName(name)
          : Option.none<ApiKnowledgeBase>();

      const kb = yield* Option.match(observed, {
        onSome: Effect.succeed,
        onNone: () =>
          Effect.gen(function* () {
            const embeddingModel = yield* resolveModel(
              news.embeddingModel,
              "MODEL_USECASE_KNOWLEDGEBASE",
            );
            const { knowledge_base } = yield* DO.createGenaiKnowledgeBase({
              name,
              project_id: news.projectId,
              embedding_model_uuid: embeddingModel,
              region: news.region ?? "tor1",
              database_id: news.databaseId,
              tags: news.tags,
              datasources: news.sources.map(toWire),
            });
            return knowledge_base;
          }),
      });

      const tagsInSync =
        news.tags === undefined ||
        [...(kb.tags ?? [])].sort().join(",") === [...news.tags].sort().join(",");
      if (kb.name !== name || kb.project_id !== news.projectId || !tagsInSync) {
        yield* DO.updateGenaiKnowledgeBase({
          uuid: kb.uuid,
          name,
          project_id: news.projectId,
          tags: news.tags,
        });
      }

      // Sync sources against what the knowledge base actually holds.
      const observedSources = yield* listSources(kb.uuid);
      const observedKeys = new Map(
        observedSources.flatMap((s) => {
          const key = keyOfObserved(s);
          return key !== undefined && s.uuid !== undefined ? [[key, s.uuid] as const] : [];
        }),
      );
      const desiredKeys = new Set(news.sources.map(keyOfSource));
      const added: string[] = [];
      for (const source of news.sources) {
        if (observedKeys.has(keyOfSource(source))) continue;
        const { knowledge_base_data_source } = yield* DO.createGenaiKnowledgeBaseDataSource({
          knowledge_base_uuid: kb.uuid,
          ...toWire(source),
        });
        if (knowledge_base_data_source?.uuid) added.push(knowledge_base_data_source.uuid);
      }
      for (const [key, sourceId] of observedKeys) {
        if (desiredKeys.has(key)) continue;
        yield* ignoreNotFound(
          DO.deleteGenaiKnowledgeBaseDataSource({
            knowledge_base_uuid: kb.uuid,
            data_source_uuid: sourceId,
          }),
        );
      }
      if (added.length > 0) {
        yield* DO.createGenaiIndexingJob({
          knowledge_base_uuid: kb.uuid,
          data_source_uuids: added,
        });
      }

      const final = yield* observeById(kb.uuid);
      return toAttrs(
        Option.getOrElse(final, () => kb),
        ownsDatabase,
      );
    }),
    delete: Effect.fn(function* ({ output }) {
      // The provisioned database's id can appear only after create returns.
      const live = yield* observeById(output.knowledgeBaseId);
      const databaseId = Option.getOrUndefined(live)?.database_id ?? output.databaseId;
      yield* ignoreNotFound(DO.deleteGenaiKnowledgeBase({ uuid: output.knowledgeBaseId }));
      // DigitalOcean keeps the OpenSearch cluster it provisioned; it was
      // created for this knowledge base only.
      if (output.ownsDatabase && databaseId) {
        yield* ignoreNotFound(DO.databasesDestroyCluster({ database_cluster_uuid: databaseId }));
      }
    }),
  });
