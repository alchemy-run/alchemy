import fs from "node:fs/promises";
import path from "node:path";
import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { DockerApi } from "./api.ts";

/**
 * Properties for creating a Docker image
 */
export interface ImageProps {
  /**
   * Repository name for the image (e.g., "username/image")
   *
   * @default id
   */
  name?: string;

  /**
   * Tag for the image (e.g., "latest")
   */
  tag?: string;

  /**
   * Path to the Dockerfile, relative to context
   *
   * @default "./Dockerfile"
   */
  dockerfile?: string;

  build?: {
    /**
     * Path to the build context directory
     *
     * If not provided, defaults to the directory containing the Dockerfile
     */
    context?: string;

    /**
     * Target build platform (e.g., linux/amd64)
     */
    platform?: string;

    /**
     * Build arguments as key-value pairs
     */
    args?: Record<string, string>;

    /**
     * Target build stage in multi-stage builds
     */
    target?: string;

    /**
     * List of images to use for cache
     */
    cacheFrom?: string[];
  };

  /**
   * Whether to skip pushing the image to registry
   */
  skipPush?: boolean;
}

/**
 * Docker Image resource
 */
export interface Image extends Resource<"docker::Image">, ImageProps {
  /**
   * Full image reference (name:tag)
   */
  imageRef: string;

  /**
   * Image ID
   */
  imageId?: string;

  /**
   * Repository digest if pushed
   */
  repoDigest?: string;

  /**
   * Time when the image was built
   */
  builtAt: number;
}

/**
 * Build and manage a Docker image from a Dockerfile
 *
 * @example
 * // Build a Docker image from a Dockerfile
 * const appImage = await Image("app-image", {
 *   name: "myapp",
 *   tag: "latest",
 *   context: "./app",
 *   dockerfile: "Dockerfile",
 *   buildArgs: {
 *     NODE_ENV: "production"
 *   }
 * });
 *
 * @example
 * // Build using a Dockerfile in a subdirectory (context inferred)
 * const apiImage = await Image("api-image", {
 *   name: "myapi",
 *   dockerfile: "./services/api/Dockerfile"
 * });
 */
export const Image = Resource(
  "docker::Image",
  async function (
    this: Context<Image>,
    id: string,
    props: ImageProps,
  ): Promise<Image> {
    // Initialize Docker API client
    const api = new DockerApi();

    const imageName = props.name ?? id;

    if (this.phase === "delete") {
      // No action needed for delete as Docker images aren't automatically removed
      // This is intentional as other resources might depend on the same image
      return this.destroy();
    } else {
      // Normalize properties
      const tag = props.tag || "latest";
      const imageRef = `${imageName}:${tag}`;

      // Determine Dockerfile path and context
      const dockerfile = props.dockerfile || "Dockerfile";

      // If context is not provided, infer from dockerfile directory
      let context: string;
      if (props.build?.context) {
        context = props.build.context;
      } else {
        // If dockerfile is an absolute path, use its directory as context
        // Otherwise, use current directory as context
        if (path.isAbsolute(dockerfile)) {
          context = path.dirname(dockerfile);
        } else {
          context = ".";
        }
      }

      // Validate build context
      await fs.access(context);

      // Determine full Dockerfile path
      const dockerfilePath = path.isAbsolute(dockerfile)
        ? dockerfile
        : path.join(context, dockerfile);
      await fs.access(dockerfilePath);

      // Prepare build options
      const buildOptions: Record<string, string> = props.build?.args || {};

      // Add platform if specified
      let buildArgs = ["build", "-t", imageRef];

      if (props.build?.platform) {
        buildArgs.push("--platform", props.build.platform);
      }

      // Add target if specified
      if (props.build?.target) {
        buildArgs.push("--target", props.build.target);
      }

      // Add cache sources if specified
      if (props.build?.cacheFrom && props.build.cacheFrom.length > 0) {
        for (const cacheSource of props.build.cacheFrom) {
          buildArgs.push("--cache-from", cacheSource);
        }
      }

      // Add build arguments
      for (const [key, value] of Object.entries(buildOptions)) {
        buildArgs.push("--build-arg", `${key}="${value}"`);
      }

      // Add dockerfile if not the default
      if (props.dockerfile && props.dockerfile !== "Dockerfile") {
        buildArgs.push("-f", props.dockerfile);
      }

      // Add context path
      buildArgs.push(context);

      // Execute build command
      console.log(`Building Docker image: ${imageRef}`);
      const { stdout } = await api.exec(buildArgs);

      // Extract image ID from build output if available
      const imageIdMatch = /Successfully built ([a-f0-9]+)/.exec(stdout);
      const imageId = imageIdMatch ? imageIdMatch[1] : undefined;

      console.log(`Successfully built Docker image: ${imageRef}`);

      // Handle push if required
      let repoDigest: string | undefined;
      if (!props.skipPush) {
        console.log(`Pushing Docker image: ${imageRef}`);
        // TODO: Implement push once API supports it
        console.warn("Image pushing is not yet implemented");
      }

      // Return the resource using this() to construct output
      return this({
        ...props,
        imageRef,
        imageId,
        repoDigest,
        builtAt: Date.now(),
      });
    }
  },
);
