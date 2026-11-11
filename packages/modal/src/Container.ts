import type * as Bundle from "alchemy/Bundle/Bundle";
import type { PlatformProps } from "alchemy/Platform";
import type * as Effect from "effect/Effect";
import type { App } from "./App.ts";
import type { Mount } from "./Mounts.ts";
import type { Providers } from "./Providers.ts";
import type { DurationInput } from "./SandboxClient.ts";

/** A resource, or the module-scope Effect that declares it. */
export type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Container settings shared by `Modal.Function` and `Modal.Server`: the
 * program, the image it runs on, and Modal's resource, scaling and
 * placement options.
 */
export interface ContainerProps extends PlatformProps {
  /**
   * Module entrypoint, bundled into the image. Typically `import.meta.url`.
   * A change to the bundle builds a new image.
   */
  main: string;
  /** The App the function is deployed in. Changing it replaces the function. */
  app: Ref<App>;
  /**
   * Name of the function in its App, unique per App. Changing it replaces
   * the function.
   * @default the logical ID
   */
  name?: string;
  /**
   * Base image the bundle runs on. It needs Bun on the `PATH`; Alchemy adds
   * Python (see {@link python}).
   * @default "oven/bun:1"
   */
  image?: string;
  /** Dockerfile lines run on the base before the bundle is added. */
  commands?: string[];
  /**
   * Standalone Python added to the image. Modal starts every Function
   * container with its Python entrypoint, which then starts the program.
   * Set `false` when the base image already has Python 3.10+ on the `PATH`.
   * @default "3.12"
   */
  python?: string | false;
  /**
   * Port the program listens on.
   * @default 8000
   */
  port?: number;
  /**
   * Named export to load from `main`.
   * @default "default"
   */
  handler?: string;
  /**
   * Extra environment variables for the program. Stored, with the bindings'
   * env, in a Modal Secret attached to the function.
   */
  env?: Record<string, any>;
  /** Bundler options. */
  build?: Bundle.BundleConfig;
  /** Secrets whose variables the program sees as environment variables. */
  secrets?: Array<Ref<{ readonly secretId: string }>>;
  /**
   * Volumes and cloud buckets mounted into every container:
   * `{ volume: Data, path: "/data" }`, `{ bucket: Uploads, path: "/uploads", secret: R2Keys }`.
   * `Modal.MountVolume` and `Modal.MountBucket` add more from the program.
   */
  mounts?: Mount[];
  /** CPU cores to reserve (fractional allowed). */
  cpu?: number;
  /** Most CPU cores a container may use. */
  cpuLimit?: number;
  /** Memory in MiB to reserve. */
  memory?: number;
  /** Most memory in MiB a container may use. */
  memoryLimit?: number;
  /** GPU: `"T4"`, `"L4"`, `"A10G"`, `"A100-80GB"`, `"H100"`, ..., with an optional `":<count>"`. */
  gpu?: string;
  /** Ephemeral disk in MiB. */
  ephemeralDisk?: number;
  /**
   * Most time one input (a call, a request) may run.
   * @default 300 seconds
   */
  timeout?: DurationInput;
  /**
   * Most time a container may take to start.
   * @default the timeout
   */
  startupTimeout?: DurationInput;
  /** Containers kept running even with no traffic. @default 0 */
  minContainers?: number;
  /** Most containers running at once. */
  maxContainers?: number;
  /** Idle containers kept on top of demand while the function is busy. */
  bufferContainers?: number;
  /** Seconds of sustained demand before scaling up. */
  scaleupWindow?: number;
  /** Seconds a container may stay idle before it scales down. */
  scaledownWindow?: number;
  /** Regions containers may run in (`"us-east"`, `"eu"`, ...). */
  regions?: string[];
  /** Cloud provider containers run on. */
  cloud?: "aws" | "gcp" | "oci" | "auto";
  /** Run on non-preemptible capacity (costs more). */
  nonpreemptible?: boolean;
  /** A `Modal.Proxy` outbound traffic goes through (static egress IPs). */
  proxy?: Ref<{ readonly proxyId: string }>;
  /** Block all outbound network access. */
  blockNetwork?: boolean;
  /** Stop the program from calling Modal's API with the container's identity. */
  restrictModalAccess?: boolean;
  /** Snapshot the container's memory after startup, so cold starts restore it. */
  enableMemorySnapshot?: boolean;
  /** Enable IPv6 networking between the function's containers. */
  i6pn?: boolean;
  /** Pin Modal's image builder version (`"2025.06"`). */
  builderVersion?: string;
}
