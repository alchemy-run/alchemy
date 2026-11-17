import * as DO from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import { pollUntil, type PollBudget } from "../internal/poll.ts";
import type { Providers } from "../Providers.ts";

/** Where a custom model's weights come from. */
export type CustomModelSource =
  | {
      /** A Hugging Face repository, like `Qwen/Qwen2.5-0.5B-Instruct`. */
      readonly huggingFace: string;
      /** The commit to import. @default the repository's main branch */
      readonly commitSha?: string;
      /**
       * A Hugging Face token, for gated or private repositories.
       * DigitalOcean stores it to read the repository.
       */
      readonly token?: Redacted.Redacted<string>;
    }
  | {
      /** A Spaces bucket holding the model's files. */
      readonly bucket: string;
      /** The bucket's region. */
      readonly region: string;
      /** The folder in the bucket. @default the bucket's root */
      readonly prefix?: string;
    };

export type CustomModelProps = {
  /** Where the weights come from. A change replaces the model. */
  source: CustomModelSource;
  /**
   * Name. A change replaces the model.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Description. Updates in place. */
  description?: string;
  /** The GPU region the model deploys to by default. A change replaces the model. */
  preferredGpuRegion?: string;
  /** Tags. Update in place. */
  tags?: string[];
};

export type CustomModel = Resource<
  "DigitalOcean.GenAI.CustomModel",
  CustomModelProps,
  {
    /** Model UUID. */
    customModelId: string;
    /** Name. */
    name: string;
    /** `STATUS_READY` once the import finished. */
    status: string;
    /** Architecture, from the model's `config.json`. */
    architecture: string | undefined;
    /** Longest context the model accepts, in tokens. */
    contextLength: number | undefined;
    /** Size of the model's files, in bytes. */
    totalSizeBytes: string | undefined;
  },
  never,
  Providers
>;

export type CustomModelAttributes = CustomModel["Attributes"];

/** A custom model's import failed. */
export class CustomModelImportFailed extends Data.TaggedError(
  "DigitalOcean.GenAI.CustomModelImportFailed",
)<{ readonly customModelId: string; readonly reason: string }> {
  override get message() {
    return `Importing custom model ${this.customModelId} failed: ${this.reason}`;
  }
}

/**
 * An open-weight model imported into your team, from a Hugging Face
 * repository or a Spaces bucket, to serve with Dedicated Inference.
 * Deploy waits until the import finishes.
 *
 * ### Importing a Model
 * **Example:** From Hugging Face
 * ```typescript
 * const model = yield* DigitalOcean.GenAI.CustomModel("Qwen", {
 *   source: { huggingFace: "Qwen/Qwen2.5-0.5B-Instruct" },
 * });
 * ```
 *
 * **Example:** A gated model, with your Hugging Face token
 * ```typescript
 * const token = yield* Config.Redacted("HF_TOKEN");
 * const model = yield* DigitalOcean.GenAI.CustomModel("Llama", {
 *   source: { huggingFace: "meta-llama/Llama-3.2-1B-Instruct", token },
 * });
 * ```
 *
 * **Example:** From a Spaces bucket
 * ```typescript
 * const model = yield* DigitalOcean.GenAI.CustomModel("FineTuned", {
 *   source: { bucket: "models", region: "nyc3", prefix: "my-model/" },
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/products/genai-platform/
 *
 * @resource
 * @product GenAI Platform
 * @category AI
 */
export const CustomModel = Resource<CustomModel>("DigitalOcean.GenAI.CustomModel");

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

// Imports copy the weights into DigitalOcean's storage: about a minute per
// few hundred megabytes (≈ 15 min budget).
const IMPORT_POLL: PollBudget = { maxDelay: "15 seconds", times: 70 };

const sourceOf = (source: CustomModelSource) =>
  "huggingFace" in source
    ? {
        source_type: "SOURCE_TYPE_HUGGINGFACE" as const,
        source_ref: {
          repo_id: source.huggingFace,
          commit_sha: source.commitSha,
          hf_token: source.token === undefined ? undefined : Redacted.value(source.token),
        },
        accept_hf_token_storage: source.token !== undefined ? true : undefined,
      }
    : {
        source_type: "SOURCE_TYPE_SPACES_BUCKET" as const,
        source_ref: { bucket: source.bucket, region: source.region, prefix: source.prefix },
      };

const sourceKey = (source: CustomModelSource) =>
  "huggingFace" in source
    ? `hf:${source.huggingFace}@${source.commitSha ?? ""}`
    : `spaces:${source.region}/${source.bucket}/${source.prefix ?? ""}`;

const observe = (uuid: string) =>
  noneIfNotFound(DO.getGenaiCustomModel({ uuid }).pipe(Effect.map((r) => r.model))).pipe(
    Effect.map((model) =>
      Option.filter(
        model,
        (m): m is DO.ApiCustomModel => m !== undefined && m.status !== "STATUS_DELETED",
      ),
    ),
  );

const toAttrs = (uuid: string, model: DO.ApiCustomModel): CustomModelAttributes => ({
  customModelId: uuid,
  name: model.name ?? "",
  status: model.status ?? "STATUS_UNSPECIFIED",
  architecture: model.architecture,
  contextLength: model.context_length,
  totalSizeBytes: model.total_size_bytes,
});

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((x) => b.includes(x));

export const CustomModelProvider = () =>
  Provider.succeed(CustomModel, {
    stables: ["customModelId"],
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(output.customModelId);
      return Option.isSome(observed) ? toAttrs(output.customModelId, observed.value) : undefined;
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (
        sourceKey(news.source) !== sourceKey(olds.source) ||
        news.preferredGpuRegion !== olds.preferredGpuRegion ||
        (news.name !== undefined && news.name !== olds.name)
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const tags = news.tags ?? [];

      // Observe
      const observed = output === undefined ? Option.none() : yield* observe(output.customModelId);

      // Ensure
      let uuid: string;
      if (Option.isSome(observed)) {
        uuid = output!.customModelId;
      } else {
        const imported = yield* DO.importGenaiCustomModel({
          name,
          description: news.description,
          preferred_gpu_region: news.preferredGpuRegion,
          accept_terms_and_conditions: true,
          tags: { tags },
          ...sourceOf(news.source),
        });
        const created = imported.model?.uuid;
        if (created === undefined) {
          return yield* new CustomModelImportFailed({
            customModelId: "",
            reason: imported.error ?? "the import response carried no model",
          });
        }
        uuid = created;
      }

      const settled = yield* pollUntil(
        DO.getGenaiCustomModel({ uuid }).pipe(Effect.map((r) => r.model ?? {})),
        {
          ...IMPORT_POLL,
          until: (m) => m.status === "STATUS_READY" || m.status === "STATUS_FAILED",
          onTimeout: (m) =>
            new CustomModelImportFailed({
              customModelId: uuid,
              reason: `still ${m.status ?? "importing"} after the wait budget`,
            }),
        },
      );
      if (settled.status === "STATUS_FAILED") {
        return yield* new CustomModelImportFailed({
          customModelId: uuid,
          reason: settled.error_message ?? "the import failed",
        });
      }

      // Sync metadata against what DigitalOcean reports. The name can't
      // change after import.
      if (
        (settled.description ?? "") !== (news.description ?? "") ||
        !sameSet(settled.tags?.tags ?? [], tags)
      ) {
        yield* DO.updateGenaiCustomModelMetadata({
          uuid,
          description: news.description ?? "",
          tags: { tags },
        });
      }
      return toAttrs(uuid, settled);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteGenaiCustomModel({ uuid: output.customModelId }));
    }),
  });
