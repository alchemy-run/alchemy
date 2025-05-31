import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import type { CloudflareApiOptions } from "./api.ts";

/**
 * Properties for creating or updating an Images resource
 */
export interface ImagesProps extends CloudflareApiOptions {
}

/**
 * Output returned after Images creation/update
 */
export interface ImagesResource extends Resource<"cloudflare::Images">, ImagesProps {
  /**
   * The ID of the resource
   */
  id: string;

  /**
   * The type identifier
   */
  type: "images";

  /**
   * Time at which the object was created
   */
  createdAt: number;
}

/**
 * Cloudflare Images binding for image transformation and manipulation.
 * 
 * Provides access to Cloudflare Images API for transforming, drawing, and outputting images
 * within Workers. The binding requires no configuration - just the binding name.
 * 
 * @example
 * // Create an Images binding for basic image transformation:
 * const images = await Images("image-processor", {});
 * 
 * const worker = await Worker("image-worker", {
 *   entrypoint: "./src/worker.ts",
 *   bindings: {
 *     IMAGES: images
 *   }
 * });
 * 
 * @example
 * // In your worker code, access the Images API:
 * // const image = env.IMAGES.input(imageData)
 * //   .transform({ width: 800, height: 600 })
 * //   .output();
 * 
 * @example
 * // Draw overlays and watermarks:
 * // const result = env.IMAGES.input(baseImage)
 * //   .draw(overlayImage, { opacity: 0.8, top: 10, left: 10 })
 * //   .transform({ format: "webp" })
 * //   .output();
 */
export const Images = Resource(
  "cloudflare::Images",
  async function(this: Context<ImagesResource>, id: string, props: ImagesProps): Promise<ImagesResource> {
    if (this.phase === "delete") {
      return this.destroy();
    } else {
      return this({
        id,
        type: "images",
        createdAt: Date.now(),
        ...props
      });
    }
  }
);
