/**
 * Cloudflare Images binding for image transformation and manipulation.
 * 
 * Provides access to Cloudflare Images API for transforming, drawing, and outputting images
 * within Workers. The binding requires no configuration - just the binding name.
 * 
 * **Requirements:**
 * - Cloudflare Images enabled for your account
 * - For deployed Workers: image transforms must be enabled for the zone
 * 
 * @example
 * // Create an Images binding and bind to a Worker:
 * import { Worker, Images } from "alchemy/cloudflare";
 * 
 * const images = new Images();
 * 
 * const worker = await Worker("image-processor", {
 *   name: "image-processor",
 *   entrypoint: "./src/worker.ts",
 *   bindings: {
 *     IMAGES: images
 *   }
 * });
 * 
 * @example
 * // Runtime usage - Basic image transformation:
 * export default {
 *   async fetch(request: Request, env: any): Promise<Response> {
 *     const imageData = await request.arrayBuffer();
 *     
 *     const response = await env.IMAGES
 *       .input(imageData)
 *       .transform({ width: 800, height: 600, format: "webp" })
 *       .output();
 *     
 *     return response.response();
 *   }
 * };
 * 
 * @example
 * // Runtime usage - Advanced transformations with overlays:
 * const watermark: ReadableStream = await fetchWatermark();
 * const image: ReadableStream = await fetchMainImage();
 * 
 * const response = await env.IMAGES
 *   .input(image)
 *   .draw(
 *     env.IMAGES.input(watermark).transform({ width: 32, height: 32 }),
 *     { bottom: 32, right: 32 }
 *   )
 *   .output({ format: "image/avif" });
 * 
 * return response.response();
 * 
 * @see https://developers.cloudflare.com/images/transform-images/bindings/
 */
export class Images {
  public readonly type = "images";
}
