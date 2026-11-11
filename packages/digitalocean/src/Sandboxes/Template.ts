import * as DO from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { pollUntil, type PollBudget } from "../internal/poll.ts";
import type { Providers } from "../Providers.ts";
import {
  deleteMicrovm,
  MicrovmWaitTimedOut,
  observeCheckpoint,
  runSetup,
  waitUntilRunning,
  type MicrovmCheckpoint,
  defaultRegion,
  sizeOf,
  type SandboxSize,
} from "./internal.ts";

export type TemplateProps = {
  /**
   * Checkpoint name.
   *
   * @default a generated physical name
   */
  name?: string;
  /** OCI image the base boots from, for example `"node:22-bookworm"`. A change rebuilds the template. */
  image: string;
  /**
   * Shell lines run in order on the booted image before it is checkpointed,
   * for example `["apt-get update", "apt-get install -y git"]`. A change
   * rebuilds the template.
   */
  setup?: string[];
  /** Region the template lives in. A change rebuilds the template. */
  region?: string;
  /** vCPUs and memory (MiB) sandboxes from the template start with. */
  size?: SandboxSize;
};

export type Template = Resource<
  "DigitalOcean.Sandboxes.Template",
  TemplateProps,
  {
    /** Checkpoint id sandboxes start from. */
    checkpointId: string;
    /** Checkpoint name. */
    name: string;
    /** Region slug. */
    region: string | undefined;
    /** Memory captured in the checkpoint, in bytes. */
    memoryBytes: number | undefined;
    /** Disk captured in the checkpoint, in bytes. */
    diskBytes: number | undefined;
  },
  never,
  Providers
>;

export type TemplateAttributes = Template["Attributes"];

/**
 * A sandbox base: a DigitalOcean MicroVM booted from an OCI image, set up
 * with your commands, and checkpointed. Sandboxes created from it start in
 * that exact state, with packages installed and caches warm, in well under
 * a second. A new image or setup rebuilds the template, creating the new
 * checkpoint before deleting the old one.
 *
 * ### Building a Template
 * **Example:** A Node base with git
 * ```typescript
 * const base = yield* DigitalOcean.Sandboxes.Template("node-git", {
 *   image: "node:22-bookworm",
 *   setup: ["apt-get update", "apt-get install -y git"],
 * });
 * const sandbox = yield* DigitalOcean.Sandboxes.Sandbox("agent", { base });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/MicroVMs
 *
 * @resource
 * @product Sandboxes
 * @category Compute
 */
export const Template = Resource<Template>("DigitalOcean.Sandboxes.Template");

// A checkpoint of memory and disk is written within a minute or two.
const CHECKPOINT_POLL: PollBudget = { maxDelay: "5 seconds", times: 60 };

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const toAttrs = (checkpoint: MicrovmCheckpoint): TemplateAttributes => ({
  checkpointId: checkpoint.id,
  name: checkpoint.name ?? "",
  region: checkpoint.region,
  memoryBytes: checkpoint.memory_bytes,
  diskBytes: checkpoint.disk_bytes,
});

const waitUntilAvailable = (checkpointId: string) =>
  pollUntil(observeCheckpoint(checkpointId), {
    ...CHECKPOINT_POLL,
    until: (o): o is Option.Some<MicrovmCheckpoint> =>
      Option.isSome(o) &&
      (o.value.status === "CHECKPOINT_AVAILABLE" || o.value.status === "CHECKPOINT_FAILED"),
    onTimeout: (last) =>
      new MicrovmWaitTimedOut({
        id: checkpointId,
        waitingFor: "the checkpoint",
        lastState: Option.getOrUndefined(last)?.status,
      }),
  }).pipe(
    Effect.flatMap(({ value }) =>
      value.status === "CHECKPOINT_AVAILABLE"
        ? Effect.succeed(value)
        : Effect.fail(
            new MicrovmWaitTimedOut({
              id: checkpointId,
              waitingFor: "the checkpoint",
              lastState: value.status,
            }),
          ),
    ),
  );

export const TemplateProvider = () =>
  Provider.succeed(Template, {
    stables: ["checkpointId"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      return Option.getOrUndefined(
        Option.map(yield* observeCheckpoint(output.checkpointId), toAttrs),
      );
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (
        news.image !== olds.image ||
        (news.setup ?? []).join("\n") !== (olds.setup ?? []).join("\n") ||
        news.region !== olds.region ||
        JSON.stringify(news.size) !== JSON.stringify(olds.size)
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      if (output !== undefined) {
        const existing = yield* observeCheckpoint(output.checkpointId);
        if (Option.isSome(existing)) return toAttrs(existing.value);
      }
      const name = news.name ?? (yield* physicalName(id));
      // Boot the image, run the setup, checkpoint, and drop the builder.
      const region = yield* defaultRegion(news.region);
      const builder = yield* DO.createMicrovm({
        name: `${name}-builder`.slice(0, 63),
        source: { oci_ref: news.image },
        region,
        size: sizeOf(news.size),
      }).pipe(Effect.map((r) => r.microvm));
      return yield* Effect.gen(function* () {
        yield* waitUntilRunning(builder.id);
        for (const command of news.setup ?? []) yield* runSetup(builder.id, command);
        const { checkpoint } = yield* DO.createMicrovmCheckpoint({
          microvm_id: builder.id,
          name,
        });
        return toAttrs(yield* waitUntilAvailable(checkpoint.id));
      }).pipe(Effect.ensuring(Effect.ignore(deleteMicrovm(builder.id))));
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* DO.deleteMicrovmCheckpoint({ checkpoint_id: output.checkpointId }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
