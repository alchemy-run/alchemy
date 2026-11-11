import * as DO from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Providers } from "../Providers.ts";
import {
  autoPauseOf,
  deleteMicrovm,
  observeMicrovm,
  urlOf,
  waitUntilRunning,
  type Microvm,
  defaultRegion,
  sizeOf,
  type SandboxSize,
} from "./internal.ts";

export type SandboxProps = {
  /**
   * MicroVM name.
   *
   * @default a generated physical name
   */
  name?: string;
  /**
   * What the sandbox starts from: a `Sandboxes.Template` (its checkpoint) or
   * an OCI image reference. A change replaces the sandbox.
   */
  base: { readonly checkpointId: string } | string;
  /** Region. A change replaces the sandbox. */
  region?: string;
  /** vCPUs and memory (MiB). A change replaces the sandbox. */
  size?: SandboxSize;
  /** Environment variables for processes in the sandbox. A change replaces the sandbox. */
  env?: Record<string, string>;
  /** Port an HTTP server in the sandbox listens on, exposed at `url`. */
  httpPort?: number;
  /** Pause after this many idle seconds; the next request resumes it. */
  autoPauseSeconds?: number;
};

export type Sandbox = Resource<
  "DigitalOcean.Sandboxes.Sandbox",
  SandboxProps,
  {
    /** MicroVM id. */
    sandboxId: string;
    /** MicroVM name. */
    name: string;
    /** `running` or `paused`. */
    state: string;
    /** Region. */
    region: string;
    /** Public URL of `httpPort`, when one is exposed. */
    url: string | undefined;
  },
  never,
  Providers
>;

export type SandboxAttributes = Sandbox["Attributes"];

/**
 * A long-lived DigitalOcean MicroVM sandbox, started from a
 * `Sandboxes.Template` or an OCI image: an isolated Linux VM for an agent,
 * a dev environment, or untrusted code. Every prop replaces the sandbox.
 * To create sandboxes per request instead, bind `Sandboxes.CreateSandbox`
 * in a runtime.
 *
 * ### Creating a Sandbox
 * **Example:** A sandbox from a template, serving on port 3000
 * ```typescript
 * const base = yield* DigitalOcean.Sandboxes.Template("node", { image: "node:22-bookworm" });
 * const sandbox = yield* DigitalOcean.Sandboxes.Sandbox("dev", {
 *   base,
 *   httpPort: 3000,
 *   autoPauseSeconds: 600,
 * });
 * // sandbox.url serves port 3000 and resumes the VM on request.
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/MicroVMs
 *
 * @resource
 * @product Sandboxes
 * @category Compute
 */
export const Sandbox = Resource<Sandbox>("DigitalOcean.Sandboxes.Sandbox");

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const toAttrs = (microvm: Microvm): SandboxAttributes => ({
  sandboxId: microvm.id,
  name: microvm.name,
  state: microvm.state,
  region: microvm.region,
  url: urlOf(microvm),
});

const sourceOf = (base: SandboxProps["base"]) =>
  typeof base === "string" ? { oci_ref: base } : { checkpoint_id: base.checkpointId };

export const SandboxProvider = () =>
  Provider.succeed(Sandbox, {
    stables: ["sandboxId", "name", "region"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      return Option.getOrUndefined(Option.map(yield* observeMicrovm(output.sandboxId), toAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (JSON.stringify(news) !== JSON.stringify(olds)) return { action: "replace" } as const;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      if (output !== undefined) {
        const existing = yield* observeMicrovm(output.sandboxId);
        if (Option.isSome(existing) && existing.value.state !== "terminated") {
          return toAttrs(existing.value);
        }
      }
      const name = news.name ?? (yield* physicalName(id));
      const region = yield* defaultRegion(news.region);
      const { microvm } = yield* DO.createMicrovm({
        name,
        source: sourceOf(news.base),
        region,
        size: sizeOf(news.size),
        environment: news.env,
        http_port: news.httpPort,
        auto_pause: autoPauseOf(news.autoPauseSeconds),
        auto_resume: news.autoPauseSeconds !== undefined ? true : undefined,
      });
      return toAttrs(yield* waitUntilRunning(microvm.id));
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* deleteMicrovm(output.sandboxId);
    }),
  });
