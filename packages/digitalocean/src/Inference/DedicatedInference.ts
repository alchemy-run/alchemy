import * as DO from "@distilled.cloud/digitalocean";
import type { DedicatedInference as ApiDedicatedInference } from "@distilled.cloud/digitalocean";
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

export interface ModelDeployment {
  /**
   * Hugging Face model slug, for example
   * `"mistralai/Mistral-7B-Instruct-v0.3"`. `GET /v2/dedicated-inferences/gpu-model-config`
   * lists the models and the GPUs each runs on; gated models need access granted on Hugging Face.
   */
  model: string;
  /** GPUs serving the model. */
  accelerators: { gpu: string; scale?: number; type?: string }[];
  /** Model server settings, passed through. */
  workloadConfig?: Record<string, unknown>;
}

export type DedicatedInferenceProps = {
  /**
   * Name, unique per team. A change replaces the deployment.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Region with GPU capacity, for example `"tor1"`. A change replaces it. */
  region: string;
  /** VPC the private endpoint lives in. A change replaces the deployment. */
  vpcId: string;
  /** Also serve a public HTTPS endpoint. Updates in place. @default false */
  publicEndpoint?: boolean;
  /** The models to serve and their GPUs. Updates in place. */
  models: ModelDeployment[];
};

export type DedicatedInference = Resource<
  "DigitalOcean.Inference.DedicatedInference",
  DedicatedInferenceProps,
  {
    /** Deployment id. */
    dedicatedInferenceId: string;
    /** Name. */
    name: string;
    /** Public endpoint host, when `publicEndpoint` is set. */
    publicEndpoint: string | undefined;
    /** Private endpoint host inside the VPC. */
    privateEndpoint: string | undefined;
    /** The access token DigitalOcean issues with the deployment. */
    token: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
>;

export type DedicatedInferenceAttributes = DedicatedInference["Attributes"];

/**
 * A Dedicated Inference deployment: open-weight models served on GPUs
 * reserved for you, behind an OpenAI-compatible endpoint in your VPC (and
 * optionally a public one). Billed per GPU-hour while it exists. Models,
 * GPUs and the public endpoint update in place.
 *
 * ### Serving a Model
 * **Example:** Mistral 7B on one MI300X
 * ```typescript
 * const vpc = yield* DigitalOcean.Vpc("ai", { region: "atl1", ipRange: "10.40.0.0/20" });
 * const mistral = yield* DigitalOcean.Inference.DedicatedInference("mistral", {
 *   region: "atl1",
 *   vpcId: vpc.vpcId,
 *   publicEndpoint: true,
 *   models: [
 *     {
 *       model: "mistralai/Mistral-7B-Instruct-v0.3",
 *       accelerators: [{ gpu: "gpu-mi300x1-192gb" }],
 *     },
 *   ],
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/products/agent-platform/dedicated-inference/
 *
 * @resource
 * @product Dedicated Inference
 * @category AI
 */
export const DedicatedInference = Resource<DedicatedInference>(
  "DigitalOcean.Inference.DedicatedInference",
);

export class DedicatedInferenceWaitTimedOut extends Data.TaggedError(
  "DigitalOcean.Inference.DedicatedInferenceWaitTimedOut",
)<{
  readonly dedicatedInferenceId: string;
  readonly lastStatus: string | undefined;
}> {
  override get message() {
    return `Dedicated Inference ${this.dedicatedInferenceId} did not become active (last status: ${this.lastStatus ?? "missing"}).`;
  }
}

// Provisioning GPUs and loading weights takes ten to thirty minutes.
const ACTIVE_POLL: PollBudget = { maxDelay: "30 seconds", times: 90 };

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const specOf = (name: string, props: DedicatedInferenceProps) => ({
  version: 1,
  name,
  region: props.region,
  vpc: { uuid: props.vpcId },
  enable_public_endpoint: props.publicEndpoint ?? false,
  model_deployments: props.models.map((m) => ({
    model_slug: m.model,
    model_provider: "hugging_face",
    workload_config: m.workloadConfig,
    accelerators: m.accelerators.map((a) => ({
      accelerator_slug: a.gpu,
      scale: a.scale ?? 1,
      type: a.type ?? "prefill_decode",
    })),
  })),
});

const toAttrs = (
  di: ApiDedicatedInference,
  token: Redacted.Redacted<string> | undefined,
): DedicatedInferenceAttributes => ({
  dedicatedInferenceId: di.id,
  name: di.spec?.name ?? "",
  publicEndpoint: di.endpoints?.public_endpoint_fqdn,
  privateEndpoint: di.endpoints?.private_endpoint_fqdn,
  token,
});

const observe = (id: string) =>
  noneIfNotFound(
    DO.getDedicatedInference({ dedicated_inference_id: id }).pipe(
      Effect.map((r) => r.dedicated_inference),
    ),
  );

const waitUntilActive = (id: string) =>
  pollUntil(observe(id), {
    ...ACTIVE_POLL,
    until: (o): o is Option.Some<ApiDedicatedInference> =>
      Option.isSome(o) && o.value.status === "active",
    onTimeout: (last) =>
      new DedicatedInferenceWaitTimedOut({
        dedicatedInferenceId: id,
        lastStatus: Option.getOrUndefined(last)?.status,
      }),
  }).pipe(Effect.map((o) => o.value));

const sameSpec = (observed: ApiDedicatedInference, desired: ReturnType<typeof specOf>) =>
  observed.spec?.enable_public_endpoint === desired.enable_public_endpoint &&
  JSON.stringify(
    (observed.spec?.model_deployments ?? []).map((m) => [
      m.model_slug,
      (m.accelerators ?? []).map((a) => [a.accelerator_slug, a.scale]),
    ]),
  ) ===
    JSON.stringify(
      desired.model_deployments.map((m) => [
        m.model_slug,
        m.accelerators.map((a) => [a.accelerator_slug, a.scale]),
      ]),
    );

export const DedicatedInferenceProvider = () =>
  Provider.succeed(DedicatedInference, {
    stables: ["dedicatedInferenceId", "name"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(output.dedicatedInferenceId);
      return Option.getOrUndefined(Option.map(observed, (di) => toAttrs(di, output.token)));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.name !== olds.name || news.region !== olds.region || news.vpcId !== olds.vpcId) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const spec = specOf(name, news);
      const observed =
        output === undefined
          ? Option.none<ApiDedicatedInference>()
          : yield* observe(output.dedicatedInferenceId);
      if (Option.isNone(observed)) {
        const created = yield* DO.createDedicatedInference({
          spec: spec as DO.DedicatedInferenceSpecInput,
        });
        const value = created.token?.value;
        const token =
          value === undefined
            ? undefined
            : typeof value === "string"
              ? Redacted.make(value)
              : value;
        const active = yield* waitUntilActive(created.dedicated_inference.id);
        return toAttrs(active, token);
      }
      if (!sameSpec(observed.value, spec)) {
        yield* DO.patchDedicatedInference({
          dedicated_inference_id: observed.value.id,
          spec: spec as DO.DedicatedInferenceSpecInput,
        });
      }
      const active = yield* waitUntilActive(observed.value.id);
      return toAttrs(active, output?.token);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        DO.deleteDedicatedInference({ dedicated_inference_id: output.dedicatedInferenceId }),
      );
    }),
  });
