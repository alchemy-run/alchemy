// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as NodeHttp from "node:http";
import type { Sharp } from "sharp";
import type {
  ImageTransform,
  ImageDrawOptions,
} from "@cloudflare/workers-types";
const ImagesWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/images/Images.worker",
    ),
};
const ImagesStoreWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/images/ImagesStore.worker",
    ),
};
import * as Loopback from "../../globals/Loopback.ts";
import type * as LoopbackServer from "../../globals/LoopbackServer.ts";
import * as Storage from "../../globals/Storage.ts";
import {
  DEFAULT_COMPATIBILITY_DATE,
  SOCKET_USER_ENTRY,
} from "../../internal/constants.ts";
import { formatInternalWorkerModules } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import { PluginContext, type BindingHook } from "../../PluginContext.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";
import {
  BINDING_KV_BLOBS,
  BINDING_KV_ENABLE_CONTROL_ENDPOINTS,
  BINDING_KV_OBJECT,
  KV_OBJECT_CLASS_NAME,
} from "../kv-namespace/KvNamespaceOptions.shared.ts";
import type { ImagesProps } from "./ImagesOptions.shared.ts";
import {
  BINDING_IMAGES_LOOPBACK,
  BINDING_IMAGES_STORE,
  PATH_IMAGE_DELIVERY,
  PATH_IMAGES_PUBLIC_URL,
  SERVICE_IMAGES,
  SERVICE_IMAGES_STORAGE,
  SERVICE_IMAGES_STORE,
} from "./ImagesOptions.shared.ts";

export class Images extends Plugin.Service<
  Images,
  {
    /**
     * Record that a local `images` binding is in use (so the images services
     * are only emitted when at least one binding exists), register the
     * node-side loopback route that runs Sharp transforms, and resolve the
     * service designator the wrapped `cloudflare-internal:images-api` binding
     * should target.
     */
    readonly register: () => Effect.Effect<
      WorkerdConfig.ServiceDesignator,
      ConfigError,
      PluginContext | Loopback.Loopback
    >;
  }
>()("cloudflare-runtime/plugin/Images") {}

export const ImagesLive = Layer.effect(
  Images,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storage = yield* Storage.Storage;
    const enableControlEndpoints = yield* Plugin.UnsafeEnableControlEndpoints;

    const makeStorageService = Effect.gen(function* () {
      const storageDiskPath =
        "disk" in storage ? storage.disk?.path : undefined;
      if (!storageDiskPath) {
        return yield* new ConfigError({
          subtag: "Images",
          message:
            "Cannot configure Images persistence: the Storage service has no disk path.",
          hint: "Configure a disk-backed storage layer (`Storage.layerDisk` or `Storage.layerTemp`).",
        });
      }
      const persistPath = path.join(storageDiskPath, "images");
      yield* fs.makeDirectory(persistPath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              subtag: "Images",
              message: `Failed to create Images persistence directory "${persistPath}": ${cause.message}`,
              hint: "Ensure the storage directory is writable.",
              detail: { persistPath },
              cause,
            }),
        ),
      );
      return {
        name: SERVICE_IMAGES_STORAGE,
        disk: { path: persistPath, writable: true },
      } satisfies WorkerdConfig.Service;
    });

    return Images.of(
      Effect.gen(function* () {
        const { worker } = yield* PluginContext;

        let used = false;
        let loopbackService: WorkerdConfig.ServiceDesignator | undefined;
        // The workerd entry port, captured in `start` — the images worker
        // resolves it through the loopback to build absolute variant URLs
        // (Miniflare's `/core/public-url`).
        let publicPort: number | undefined;

        /**
         * Node-side handler for the images loopback route:
         *
         * - `GET {PATH_IMAGES_PUBLIC_URL}` — the runtime entry URL (or
         *   `null` before the runtime is listening).
         * - everything else — the Sharp transform/info fetcher
         *   ({@link imagesLocalFetcher}), selected by pathname (`/info` vs
         *   transform).
         */
        const handler: LoopbackServer.RawHandler = async (req, res) => {
          const url = new URL(req.url ?? "/", "http://localhost");
          if (url.pathname === PATH_IMAGES_PUBLIC_URL) {
            res
              .writeHead(200, { "content-type": "application/json" })
              .end(
                JSON.stringify(
                  publicPort === undefined
                    ? null
                    : `http://127.0.0.1:${publicPort}`,
                ),
              );
            return;
          }
          const response = await imagesLocalFetcher(
            await readNodeRequest(req, url),
          );
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        };

        return {
          api: {
            register: () =>
              Plugin.use(Loopback.Loopback, (loopback) =>
                Effect.map(
                  loopback.api.route(`images:${worker.name}`, handler),
                  (service) => {
                    used = true;
                    loopbackService = service;
                    return { name: SERVICE_IMAGES };
                  },
                ),
              ),
          },
          start: (ports) =>
            Effect.sync(() => {
              publicPort = ports[SOCKET_USER_ENTRY];
            }),
          defer: Effect.gen(function* () {
            if (!used || loopbackService === undefined) return {};
            const storageService = yield* makeStorageService;
            const storeService: WorkerdConfig.Service = {
              name: SERVICE_IMAGES_STORE,
              worker: {
                compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
                modules: formatInternalWorkerModules(
                  yield* Effect.promise(ImagesStoreWorker.worker),
                ),
                durableObjectNamespaces: [
                  {
                    className: KV_OBJECT_CLASS_NAME,
                    enableSql: true,
                    uniqueKey: `cloudflare-runtime-images-${KV_OBJECT_CLASS_NAME}`,
                    preventEviction: true,
                  },
                ],
                durableObjectStorage: { localDisk: SERVICE_IMAGES_STORAGE },
                bindings: [
                  {
                    name: BINDING_KV_OBJECT,
                    durableObjectNamespace: { className: KV_OBJECT_CLASS_NAME },
                  },
                  {
                    name: BINDING_KV_BLOBS,
                    service: { name: SERVICE_IMAGES_STORAGE },
                  },
                  ...(enableControlEndpoints
                    ? [
                        {
                          name: BINDING_KV_ENABLE_CONTROL_ENDPOINTS,
                          json: "true",
                        },
                      ]
                    : []),
                ],
              },
            };
            const imagesService: WorkerdConfig.Service = {
              name: SERVICE_IMAGES,
              worker: {
                compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
                modules: formatInternalWorkerModules(
                  yield* Effect.promise(ImagesWorker.worker),
                ),
                bindings: [
                  {
                    name: BINDING_IMAGES_STORE,
                    kvNamespace: { name: SERVICE_IMAGES_STORE },
                  },
                  {
                    name: BINDING_IMAGES_LOOPBACK,
                    service: loopbackService,
                  },
                ],
              },
            };
            // Serve hosted variant URLs (`/cdn-cgi/mf/imagedelivery/...`)
            // from the entry chain, mirroring Miniflare's core entry routing
            // (`SERVICE_IMAGES_DELIVERY`). Sits inside the `plugin:entry`
            // middleware (order 0) and before the user worker.
            const deliveryMiddleware: Plugin.Middleware = {
              name: "images:delivery",
              worker: {
                compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
                modules: [
                  {
                    name: "images/delivery.worker.js",
                    esModule: `
                      export default {
                        fetch(request, env) {
                          const url = new URL(request.url);
                          if (url.pathname.startsWith("${PATH_IMAGE_DELIVERY}/")) {
                            return env.IMAGES.fetch(request);
                          }
                          return env.UPSTREAM.fetch(request);
                        }
                      }
                    `,
                  },
                ],
                bindings: [
                  { name: "IMAGES", service: { name: SERVICE_IMAGES } },
                ],
              },
              upstreamBindingName: "UPSTREAM",
              order: 1,
            };
            return {
              services: [storageService, storeService, imagesService],
              middlewares: [deliveryMiddleware],
            };
          }),
        };
      }),
    );
  }),
);

/**
 * Bind a local Images simulator (`env.<binding>.input(...)/.info(...)` and the
 * hosted CRUD surface) for `alchemy dev`.
 *
 * The binding is workerd's real `cloudflare-internal:images-api` module
 * pointed at a local service: hosted images are stored in a KV-backed store
 * persisted under `{storage}/images` (variant URLs are served at
 * `/cdn-cgi/mf/imagedelivery/...` on the worker's own URL), and pixel work
 * (resize / rotate / transcode) runs in Node.js via Sharp over the loopback.
 *
 * Low fidelity, matching Miniflare's local mode: draws/overlays are ignored,
 * GIF and RGB/RGBA outputs fail with a 415 error (code 9520), and SVG inputs
 * are not transformed.
 */
export const local = (
  props: ImagesProps,
): BindingHook<Images | Loopback.Loopback> =>
  Plugin.use(Images, (images) =>
    Effect.map(
      images.api.register(),
      (service): WorkerdConfig.Worker_Binding => ({
        name: props.binding,
        wrapped: {
          moduleName: "cloudflare-internal:images-api",
          innerBindings: [
            {
              name: "fetcher",
              service,
            },
          ],
        },
      }),
    ),
  );

/** Bind to the deployed Images service via the remote bindings proxy. */
export const remote = (binding: string) =>
  makeRemoteBinding(
    { name: binding, type: "images", raw: true },
    (service) => ({
      name: binding,
      wrapped: {
        moduleName: "cloudflare-internal:images-api",
        innerBindings: [
          {
            name: "fetcher",
            service,
          },
        ],
      },
    }),
  );

// -----------------------------------------------------------------------------
// Node-side Sharp fetcher, adapted from Miniflare's images plugin
// (`workers-sdk/packages/miniflare/src/plugins/images/fetcher.ts`,
// `imagesLocalFetcher`). Local Sharp mock for the Images binding
// (`env.IMAGES`). Sharp supplies ordered transforms, overlays and all output formats.
// AI-driven operations require the remote Images binding. Deltas from upstream:
// - Output bytes are buffered (`toBuffer`) instead of streamed, so a Sharp
//   failure surfaces as a loopback 500 rather than a broken stream.
// - The `cf.image` outbound fetcher (`cfImageLocalFetcher`) is not ported:
//   this runtime has no outbound `fetch(url, { cf: { image } })` rewriting.
// -----------------------------------------------------------------------------

/** Read a Node.js request into a fetch `Request` (bodies are buffered). */
async function readNodeRequest(
  req: NodeHttp.IncomingMessage,
  url: URL,
): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  const method = req.method ?? "GET";
  let body: Uint8Array | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Array<Buffer> = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(url.toString(), { method, headers, body });
}

type Transform = ImageTransform &
  ImageDrawOptions & {
    imageIndex?: number;
    drawImageIndex?: number;
    targetImageIndex?: number;
  };

function validateTransforms(inputTransforms: unknown): Array<Transform> | null {
  if (!Array.isArray(inputTransforms)) {
    return null;
  }

  for (const transform of inputTransforms) {
    if (!transform || typeof transform !== "object") return null;
    for (const key of ["imageIndex", "rotate", "width", "height"]) {
      if (transform[key] !== undefined && typeof transform[key] !== "number") {
        return null;
      }
    }
  }

  return inputTransforms as Array<Transform>;
}

export async function imagesLocalFetcher(request: Request): Promise<Response> {
  let sharp;
  try {
    const { default: importedSharp } = await import("sharp");
    sharp = importedSharp;
  } catch {
    return errorResponse(
      503,
      9523,
      "The Sharp library is not available, check your version of Node is compatible",
    );
  }

  const data = await request.formData();

  const url = new URL(request.url);
  const body: unknown = data.get("image");
  const text = data.get("text_input");
  let transformer: Sharp;
  try {
    if (typeof text === "string")
      transformer = sharp(await rasterizeText(text));
    else if (body instanceof Blob) {
      if (body.size > 20 * 1024 * 1024)
        throw new Error("Images inputs must not exceed 20 MB");
      transformer = sharp(await body.arrayBuffer(), {
        animated: url.pathname !== "/info" && data.get("anim") !== "false",
      });
    } else throw new Error("Expected image bytes or text input");
  } catch (error) {
    return errorResponse(
      400,
      9523,
      error instanceof Error ? error.message : "Invalid image source",
    );
  }

  if (url.pathname === "/info") {
    return runInfo(transformer);
  } else {
    const badTransformsResponse = errorResponse(
      400,
      9523,
      "ERROR: Internal Images binding error: Expected JSON array of valid transforms in transforms field",
    );
    try {
      const transformsJson = data.get("transforms");

      if (typeof transformsJson !== "string") {
        return badTransformsResponse;
      }

      const transforms = validateTransforms(JSON.parse(transformsJson));

      if (transforms === null) {
        return badTransformsResponse;
      }

      const outputFormat = data.get("output_format");

      if (outputFormat != null && typeof outputFormat !== "string") {
        return errorResponse(
          400,
          9523,
          "ERROR: Internal Images binding error: Expected output format to be a string if provided",
        );
      }

      const qualityText = data.get("output_quality");
      const quality = qualityText === null ? undefined : Number(qualityText);
      if (
        quality !== undefined &&
        (!Number.isInteger(quality) || quality < 1 || quality > 100)
      )
        throw new Error("Output quality must be an integer between 1 and 100");
      // Multipart preserves the order of image and text overlays together.
      const draws: Buffer[] = [];
      for (const [name, source] of data.entries()) {
        if (name === "draw_text") {
          if (typeof source !== "string")
            throw new Error("Invalid text overlay");
          draws.push(await rasterizeText(source));
        } else if (name === "draw_image") {
          if (!(source instanceof Blob))
            throw new Error("Expected overlay image bytes");
          if (source.size > 20 * 1024 * 1024)
            throw new Error("Images inputs must not exceed 20 MB");
          draws.push(Buffer.from(await source.arrayBuffer()));
        }
      }
      return await runTransform(
        transformer,
        transforms,
        outputFormat,
        draws,
        quality,
        data.get("background")?.toString(),
      );
    } catch (error) {
      return errorResponse(
        400,
        9523,
        error instanceof Error
          ? error.message
          : "Invalid Images transformation",
      );
    }
  }
}

async function rasterizeText(serialized: string): Promise<Buffer> {
  const source = JSON.parse(serialized) as {
    text?: unknown;
    font?: { url?: unknown };
    size?: number;
    color?: string;
  };
  if (
    typeof source.text !== "string" ||
    source.text.length === 0 ||
    [...source.text].length > 1000
  )
    throw new Error("Text must contain between 1 and 1000 characters");
  const size = source.size ?? 12;
  if (!Number.isFinite(size) || size <= 0 || size > 4096)
    throw new Error("Invalid text size");
  if (typeof source.font?.url !== "string")
    throw new Error("A custom font URL is required");
  const fontUrl = new URL(source.font.url);
  if (fontUrl.protocol !== "http:" && fontUrl.protocol !== "https:")
    throw new Error("Font URL must use HTTP or HTTPS");
  const response = await fetch(fontUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body)
    throw new Error(`Failed to fetch font: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 20 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("Fonts must not exceed 20 MB");
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  const { create } = await import("fontkitten");
  const font = create(bytes);
  if (font.isCollection || !font.familyName)
    throw new Error("Expected a single valid font face");
  const [{ default: sharp }, fs, os, path] = await Promise.all([
    import("sharp"),
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
  ]);
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "alchemy-images-font-"),
  );
  try {
    const fontfile = path.join(directory, "font");
    await fs.writeFile(fontfile, bytes);
    // Content is literal text, never Pango markup supplied by the caller.
    const escaped = source.text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    const rendered = sharp({
      text: {
        text: escaped,
        font: `${font.familyName} ${size}`,
        fontfile,
        dpi: 72,
        rgba: true,
      },
    });
    const dimensions = await rendered.metadata();
    if (
      !dimensions.width ||
      !dimensions.height ||
      dimensions.width > 4096 ||
      dimensions.height > 4096
    )
      throw new Error("Rendered text must fit within 4096 x 4096 pixels");
    const color = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: source.color ?? "black",
      },
    })
      .raw()
      .toBuffer();
    return await rendered
      .ensureAlpha()
      .linear([0, 0, 0, color[3]! / 255], [color[0]!, color[1]!, color[2]!, 0])
      .png()
      .toBuffer();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function runInfo(transformer: Sharp): Promise<Response> {
  const metadata = await transformer.metadata();

  let mime: string | null = null;
  switch (metadata.format) {
    case "jpeg":
      mime = "image/jpeg";
      break;
    case "svg":
      mime = "image/svg+xml";
      break;
    case "png":
      mime = "image/png";
      break;
    case "webp":
      mime = "image/webp";
      break;
    case "gif":
      mime = "image/gif";
      break;
    // libvips reports both AVIF and HEIC as `heif`, distinguished by the
    // compression codec. AVIF (av1) is the only variant Cloudflare Images
    // accepts, and the only one the bundled libvips can decode.
    case "heif":
      if (metadata.compression !== "av1") {
        return errorResponse(
          415,
          9520,
          `ERROR: Unsupported image type ${metadata.format}, expected one of: JPEG, SVG, PNG, WebP, GIF or AVIF`,
        );
      }
      mime = "image/avif";
      break;
    default:
      return errorResponse(
        415,
        9520,
        `ERROR: Unsupported image type ${metadata.format}, expected one of: JPEG, SVG, PNG, WebP, GIF or AVIF`,
      );
  }

  if (mime === "image/svg+xml") {
    return Response.json({ format: mime });
  }

  if (!metadata.size || !metadata.width || !metadata.height) {
    return errorResponse(
      500,
      9523,
      "ERROR: Internal Images binding error: Expected size, width and height for bitmap input",
    );
  }

  return Response.json({
    format: mime,
    fileSize: metadata.size,
    width: metadata.width,
    height: metadata.height,
  });
}

async function runTransform(
  transformer: Sharp,
  transforms: Array<Transform>,
  outputFormat: string | null,
  draws: Array<Buffer>,
  quality?: number,
  background?: string,
): Promise<Response> {
  const { default: sharp } = await import("sharp");
  const source = await transformer.metadata();
  if ((source.pages ?? 1) > 1) {
    const pages = source.pages!,
      width = source.width!,
      height = source.pageHeight ?? source.height! / pages;
    const raw = await transformer.clone().ensureAlpha().raw().toBuffer();
    const frameBytes = width * height * 4;
    const frames: Buffer[] = [];
    const count =
      outputFormat === "image/gif" || outputFormat === "image/webp" ? pages : 1;
    for (let frame = 0; frame < count; frame++) {
      const input = sharp(
        raw.subarray(frame * frameBytes, (frame + 1) * frameBytes),
        { raw: { width, height, channels: 4 } },
      );
      const transformed = await runTransform(
        input,
        transforms,
        "image/png",
        draws,
        undefined,
        background,
      );
      frames.push(Buffer.from(await transformed.arrayBuffer()));
    }
    if (count === 1)
      return runTransform(sharp(frames[0]), [], outputFormat, [], quality);
    const animation = sharp(frames, { join: { animated: true } });
    const options = { delay: source.delay, loop: source.loop };
    const output =
      outputFormat === "image/gif"
        ? animation.gif(options)
        : animation.webp({ ...options, quality });
    return new Response(new Uint8Array(await output.toBuffer()), {
      headers: { "content-type": outputFormat! },
    });
  }
  const images = [transformer, ...draws.map((image) => sharp(image))];
  for (const transform of transforms) {
    const index = transform.targetImageIndex ?? transform.imageIndex ?? 0;
    let target = images[index];
    if (!target) throw new Error("Invalid target image index");
    // Materialize each operation so successive resize/rotate/draw calls retain
    // their order; Sharp otherwise keeps only the last resize in a pipeline.
    target = sharp(await target.png().toBuffer());
    const size = await target.metadata();
    if (transform.drawImageIndex !== undefined) {
      const overlay = images[transform.drawImageIndex];
      if (!overlay) throw new Error("Invalid overlay image index");
      let overlayImage = sharp(await overlay.png().toBuffer()).ensureAlpha();
      const opacity = transform.opacity ?? 1;
      if (opacity < 0 || opacity > 1)
        throw new Error("Overlay opacity must be between 0 and 1");
      if (opacity !== 1) overlayImage.linear([1, 1, 1, opacity], [0, 0, 0, 0]);
      const overlaySize = await overlayImage.metadata();
      let left =
        transform.left ??
        (transform.right === undefined
          ? 0
          : size.width! - overlaySize.width! - transform.right);
      let top =
        transform.top ??
        (transform.bottom === undefined
          ? 0
          : size.height! - overlaySize.height! - transform.bottom);
      if (typeof transform.repeat === "string")
        throw new Error(
          "Directional overlay repetition is not supported locally",
        );
      const clipLeft = Math.max(0, -left),
        clipTop = Math.max(0, -top);
      const width = Math.min(
        overlaySize.width! - clipLeft,
        size.width! - Math.max(0, left),
      );
      const height = Math.min(
        overlaySize.height! - clipTop,
        size.height! - Math.max(0, top),
      );
      if (width > 0 && height > 0) {
        overlayImage.extract({ left: clipLeft, top: clipTop, width, height });
        const blend =
          transform.composite === "lighter"
            ? "add"
            : (transform.composite ?? "over");
        target.composite([
          {
            input: await overlayImage.png().toBuffer(),
            left: Math.max(0, left),
            top: Math.max(0, top),
            blend,
            tile: transform.repeat === true,
          },
        ]);
      }
    } else {
      if (
        transform.segment !== undefined ||
        transform.gravity === "face" ||
        typeof transform.gravity === "object"
      )
        throw new Error(
          "AI segmentation, face gravity, and coordinate gravity are not supported locally",
        );
      if (transform.trim === "border") target.trim();
      else if (transform.trim !== undefined) {
        if (transform.trim.border)
          throw new Error("Custom border trimming is not supported locally");
        const left = transform.trim.left ?? 0,
          top = transform.trim.top ?? 0;
        target.extract({
          left,
          top,
          width:
            transform.trim.width ??
            size.width! - left - (transform.trim.right ?? 0),
          height:
            transform.trim.height ??
            size.height! - top - (transform.trim.bottom ?? 0),
        });
      }
      if (transform.rotate !== undefined) target.rotate(transform.rotate);
      if (transform.flip?.includes("h")) target.flop();
      if (transform.flip?.includes("v")) target.flip();
      if (transform.width !== undefined || transform.height !== undefined) {
        const fit = transform.fit ?? "scale-down";
        target.resize(transform.width ?? null, transform.height ?? null, {
          fit:
            fit === "pad"
              ? "contain"
              : fit === "squeeze"
                ? "fill"
                : fit === "contain" || fit === "scale-down"
                  ? "inside"
                  : "cover",
          withoutEnlargement: fit === "scale-down" || fit === "crop",
          position:
            transform.gravity === "auto" ? "attention" : transform.gravity,
          background: transform.background,
        });
      }
      if (transform.blur !== undefined && transform.blur !== 0)
        target.blur(transform.blur);
      if (transform.sharpen !== undefined && transform.sharpen !== 0)
        target.sharpen({ sigma: transform.sharpen });
      if (
        transform.brightness !== undefined ||
        transform.saturation !== undefined
      )
        target.modulate({
          brightness: transform.brightness,
          saturation: transform.saturation,
        });
      if (transform.contrast !== undefined)
        target.linear(transform.contrast, 128 * (1 - transform.contrast));
      if (transform.gamma !== undefined && transform.gamma !== 1)
        target.gamma(transform.gamma);
      if (transform.border) {
        const border = transform.border;
        const width = "width" in border ? (border.width ?? 0) : 0;
        target.extend({
          top: "top" in border ? (border.top ?? 0) : width,
          bottom: "bottom" in border ? (border.bottom ?? 0) : width,
          left: "left" in border ? (border.left ?? 0) : width,
          right: "right" in border ? (border.right ?? 0) : width,
          background: "color" in border ? border.color : undefined,
        });
      }
    }
    images[index] = target;
  }
  transformer = images[0]!;
  if (background !== undefined) transformer.flatten({ background });
  switch (outputFormat) {
    case "image/avif":
      transformer.avif({ quality });
      break;
    case "image/gif":
      transformer.gif();
      break;
    case "image/png":
      transformer.png(quality === undefined ? {} : { quality, palette: true });
      break;
    case "image/webp":
      transformer.webp({ quality });
      break;
    case "rgb":
      transformer.toColourspace("srgb").removeAlpha().raw();
      break;
    case "rgba":
      transformer.toColourspace("srgb").ensureAlpha().raw();
      break;
    case "image/jpeg":
      transformer.jpeg({ quality });
      break;
    default:
      outputFormat = "image/jpeg";
      transformer.jpeg({ quality });
  }
  return new Response(new Uint8Array(await transformer.toBuffer()), {
    headers: { "content-type": outputFormat },
  });
}

function errorResponse(
  status: number,
  code: number,
  message: string,
): Response {
  return new Response(`ERROR ${code}: ${message}`, {
    status,
    headers: {
      "content-type": "text/plain",
      "cf-images-binding": `err=${code}`,
    },
  });
}
