import type { Docker } from "./Docker.ts";
import type { DockerBuildOptions } from "./ImageBuild.ts";
import type { InlineDockerfile } from "./Dockerfile.ts";
import type { ImagePublish } from "./ImageRegistry.ts";

/** Options shared by embedded build and existing-image specifications. */
export interface ImageOptionsBase {
  /** Image platform. Defaults to the consuming platform's architecture. */
  platform?: string;
  /** Publication destination. A consuming platform may resolve relative repository names. */
  publish?: ImagePublish;
  /** Docker daemon context name or context resource. */
  dockerContext?: Docker.ContextRef;
}

/** Build an image from a directory or Dockerfile; mutually exclusive with `ref`. */
export type BuildImageOptions = ImageOptionsBase &
  DockerBuildOptions & {
    /** Existing image references cannot be combined with build inputs. */
    ref?: never;
    /** Mutable-reference refresh applies only to existing images. */
    alwaysPull?: never;
  } & ({ context: string } | { dockerfile: string | InlineDockerfile });

/** Consume an existing image; mutually exclusive with Dockerfile build inputs. */
export type RemoteImageOptions = ImageOptionsBase & {
  /** Existing image tag, digest reference, or local image ID. */
  ref: string;
  /** Refresh mutable image references. @default true */
  alwaysPull?: boolean;
} & {
  [K in Exclude<keyof DockerBuildOptions, "platform">]?: never;
};

/** Plain image data consumed by a platform that creates a managed child resource. */
export type ImageOptions = BuildImageOptions | RemoteImageOptions;
