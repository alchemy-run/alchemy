import type * as runtime from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as R2Bucket from "./bindings/r2-bucket/R2Bucket.ts";
import * as Docker from "./Docker.ts";
import { getAddress } from "./internal/get-address.ts";
import { open } from "./platform-proxy/PlatformProxy.ts";
import * as Runtime from "./Runtime.ts";
import { SystemError } from "./RuntimeError.shared.ts";
import {
  decodeS3BucketAlias,
  R2_FUSE_MARKER_ENV,
  S3_GATEWAY_URL_ENV,
} from "./S3GatewayProtocol.shared.ts";

/**
 * The dev-session S3 gateway: a minimal S3-compatible HTTP façade over
 * the LOCAL R2 simulator, so S3 clients that speak to real R2's S3
 * endpoint — specifically FUSE adapters (`tigrisfs`) mounting a bucket
 * inside a dev container — work against `dev:` buckets with no cloud
 * involved. Data lands in the same `{storage}/r2` store every local
 * Worker binding reads.
 *
 * Deliberately NOT a general S3 implementation: it covers exactly the
 * operations geesefs/tigrisfs issue under the flags alchemy's
 * `FuseMountTigrisfs` passes in dev (`--no-detect
 * --no-expire-multipart --list-type 2`): Head/Get(+Range)/Put/Delete
 * object(s), ListObjects V1+V2, CopyObject (emulated get+put), and the
 * four core multipart calls (parts staged on the gateway's disk; a
 * single simulator `put` on complete). Requests are NOT authenticated
 * — the server exists for the local machine's containers.
 *
 * The server and its per-bucket platform proxies start lazily on first
 * demand: building the layer only registers a Docker container-create
 * transform, which — for containers carrying the
 * {@link R2_FUSE_MARKER_ENV} marker — starts the gateway, grants the
 * container the FUSE device + capability, and injects the gateway's
 * container-reachable URL as {@link S3_GATEWAY_URL_ENV}. Unmarked
 * containers are untouched.
 */
export class S3Gateway extends Context.Service<
  S3Gateway,
  {
    /** Start (once) and return the gateway's host-side base URL. */
    readonly url: Effect.Effect<URL, SystemError>;
  }
>()("cloudflare-runtime/S3Gateway") {}

export const S3GatewayLive: Layer.Layer<
  S3Gateway,
  never,
  Runtime.Runtime | R2Bucket.R2Bucket | Docker.Docker
> = Layer.effect(
  S3Gateway,
  Effect.gen(function* () {
    const docker = yield* Docker.Docker;
    // `open` starts a workerd through Runtime whose R2 binding hook
    // resolves the R2Bucket plugin — both must ride the captured context
    const context = yield* Effect.context<
      Runtime.Runtime | R2Bucket.R2Bucket
    >();
    const scope = yield* Effect.scope;

    /**
     * One long-lived platform proxy per bucket, created on first use in
     * the LAYER scope (a tigrisfs mount lives as long as its container,
     * so per-request proxies are out). The proxy hosts the standard
     * local R2 binding — same simulator, same on-disk data as every
     * worker binding.
     */
    const buckets = new Map<string, Promise<runtime.R2Bucket>>();
    const bucket = (alias: string): Promise<runtime.R2Bucket> => {
      let proxy = buckets.get(alias);
      if (proxy === undefined) {
        const bucketName = decodeS3BucketAlias(alias);
        proxy = Effect.runPromise(
          open({
            name: `s3-gateway-${NodeCrypto.createHash("sha256").update(bucketName).digest("hex").slice(0, 16)}`,
            bindings: [R2Bucket.local({ binding: "R2", id: bucketName })],
          }).pipe(
            Effect.map(
              (instance) =>
                (instance.env as Record<string, unknown>)
                  .R2 as runtime.R2Bucket,
            ),
            Scope.provide(scope),
            Effect.provide(context),
            Effect.orDie,
          ),
        );
        buckets.set(alias, proxy);
        proxy.catch(() => buckets.delete(alias));
      }
      return proxy;
    };

    const start: Effect.Effect<URL, SystemError> = Effect.gen(function* () {
      const uploads = new Map<string, MultipartUpload>();
      const server = NodeHttp.createServer((req, res) => {
        handleRequest(bucket, uploads, req, res).catch((error) => {
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/xml" });
          }
          res.end(
            errorXml("InternalError", (error as Error)?.message ?? "error"),
          );
        });
      });
      server.keepAliveTimeout = 60_000;
      server.headersTimeout = 65_000;
      yield* Effect.callback<void>((resume) => {
        // 0.0.0.0: on Linux the container reaches the host through the
        // bridge gateway (`host-gateway`), which cannot see 127.0.0.1
        server.listen(0, "0.0.0.0", () => resume(Effect.void));
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          server.close();
          server.closeAllConnections();
        }),
      );
      // getAddress normalizes the bind-all host to a connectable loopback
      const address = yield* getAddress(server);
      return new URL(`http://${address}`);
    }).pipe(Scope.provide(scope));

    const url = yield* Effect.cached(start);

    /**
     * The scoped injection: only containers that declared the FUSE
     * marker get the device, the capability, and the gateway URL.
     */
    yield* docker.registerContainerCreateTransform(async (body) => {
      const marked = body.Env?.some((entry) =>
        entry.startsWith(`${R2_FUSE_MARKER_ENV}=`),
      );
      if (!marked) return body;
      const gateway = await Effect.runPromise(url);
      const hostConfig = (body.HostConfig ?? {}) as {
        Devices?: Array<unknown>;
        CapAdd?: Array<string>;
        ExtraHosts?: Array<string>;
      };
      return {
        ...body,
        Env: [
          ...(body.Env ?? []),
          `${S3_GATEWAY_URL_ENV}=http://host.docker.internal:${gateway.port}`,
        ],
        // NOTE: no ExtraHosts — workerd attaches the container to its
        // egress proxy's network namespace (`NetworkMode: container:…`),
        // and Docker rejects host-to-IP mappings in that mode. Name
        // resolution comes from the proxy's netns: Docker Desktop
        // resolves `host.docker.internal` natively; plain Linux bridges
        // need the proxy container to carry the mapping (not wired yet).
        HostConfig: {
          ...hostConfig,
          Devices: [
            ...(hostConfig.Devices ?? []),
            {
              PathOnHost: "/dev/fuse",
              PathInContainer: "/dev/fuse",
              CgroupPermissions: "rwm",
            },
          ],
          CapAdd: [...(hostConfig.CapAdd ?? []), "SYS_ADMIN"],
        },
      };
    });

    return S3Gateway.of({ url });
  }),
);

// ---------------------------------------------------------------------------
// Request handling (plain async: the R2 proxy surface is Promise-based)
// ---------------------------------------------------------------------------

interface MultipartUpload {
  readonly alias: string;
  readonly key: string;
  readonly directory: string;
  readonly options: R2PutMetadata;
}

interface R2PutMetadata {
  readonly httpMetadata: Record<string, string>;
  readonly customMetadata: Record<string, string>;
}

type Bucket = (alias: string) => Promise<runtime.R2Bucket>;

const handleRequest = async (
  bucket: Bucket,
  uploads: Map<string, MultipartUpload>,
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
): Promise<void> => {
  const url = new URL(req.url ?? "/", "http://s3-gateway");
  const [alias, key] = parsePath(url.pathname);
  const method = req.method ?? "GET";

  if (alias === undefined) {
    // ListBuckets and friends — nothing needs them
    return respondXml(
      res,
      200,
      `<ListAllMyBucketsResult></ListAllMyBucketsResult>`,
    );
  }

  // ── bucket-level ─────────────────────────────────────────────────
  if (key === undefined || key === "") {
    if (method === "HEAD") {
      res.writeHead(200).end();
      return;
    }
    if (method === "GET") {
      return listObjects(await bucket(alias), alias, url, res);
    }
    if (method === "POST" && url.searchParams.has("delete")) {
      return deleteObjects(await bucket(alias), await readBody(req), res);
    }
    return respondError(res, 405, "MethodNotAllowed", `${method} on bucket`);
  }

  // ── multipart ────────────────────────────────────────────────────
  if (method === "POST" && url.searchParams.has("uploads")) {
    const uploadId = NodeCrypto.randomUUID();
    const directory = await NodeFs.mkdtemp(
      NodePath.join(NodeOs.tmpdir(), "alchemy-s3-gateway-"),
    );
    uploads.set(uploadId, {
      alias,
      key,
      directory,
      options: putMetadata(req.headers),
    });
    return respondXml(
      res,
      200,
      `<InitiateMultipartUploadResult>` +
        `<Bucket>${escapeXml(alias)}</Bucket>` +
        `<Key>${escapeXml(key)}</Key>` +
        `<UploadId>${uploadId}</UploadId>` +
        `</InitiateMultipartUploadResult>`,
    );
  }
  const uploadId = url.searchParams.get("uploadId");
  if (uploadId !== null) {
    const upload = uploads.get(uploadId);
    if (upload === undefined || upload.alias !== alias || upload.key !== key) {
      return respondError(res, 404, "NoSuchUpload", uploadId);
    }
    const partNumber = url.searchParams.get("partNumber");
    if (method === "PUT" && partNumber !== null) {
      return uploadPart(bucket, upload, Number(partNumber), req, res);
    }
    if (method === "POST") {
      return completeMultipartUpload(
        await bucket(alias),
        uploads,
        uploadId,
        upload,
        await readBody(req),
        res,
      );
    }
    if (method === "DELETE") {
      uploads.delete(uploadId);
      await NodeFs.rm(upload.directory, { recursive: true, force: true });
      res.writeHead(204).end();
      return;
    }
    return respondError(res, 405, "MethodNotAllowed", `${method} on upload`);
  }

  // ── object-level ─────────────────────────────────────────────────
  switch (method) {
    case "HEAD": {
      const object = await (await bucket(alias)).head(key);
      if (object === null) {
        // geesefs probes with HEAD constantly; a bodyless 404 is enough
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, objectHeaders(object)).end();
      return;
    }
    case "GET": {
      const range = parseRange(req.headers.range);
      const object = await (
        await bucket(alias)
      ).get(key, range ? { range } : undefined);
      if (object === null || !("body" in object)) {
        return respondError(res, 404, "NoSuchKey", key);
      }
      const body = Buffer.from(await object.arrayBuffer());
      const headers = objectHeaders(object);
      headers["content-length"] = String(body.byteLength);
      if (range !== undefined && object.range !== undefined) {
        const returned = object.range as { offset?: number; length?: number };
        const offset = returned.offset ?? 0;
        headers["content-range"] =
          `bytes ${offset}-${offset + body.byteLength - 1}/${object.size}`;
        res.writeHead(206, headers).end(body);
        return;
      }
      res.writeHead(200, headers).end(body);
      return;
    }
    case "PUT": {
      const source = req.headers["x-amz-copy-source"];
      if (typeof source === "string") {
        return copyObject(bucket, alias, key, source, req, res);
      }
      const body = await readBody(req);
      const meta = putMetadata(req.headers);
      const object = await (
        await bucket(alias)
      ).put(key, body, {
        httpMetadata: meta.httpMetadata,
        customMetadata: meta.customMetadata,
      } as runtime.R2PutOptions);
      res.writeHead(200, { etag: object!.httpEtag }).end();
      return;
    }
    case "DELETE": {
      await (await bucket(alias)).delete(key);
      res.writeHead(204).end();
      return;
    }
    default:
      return respondError(res, 405, "MethodNotAllowed", method);
  }
};

// ── operations ───────────────────────────────────────────────────────

const listObjects = async (
  bucket: runtime.R2Bucket,
  alias: string,
  url: URL,
  res: NodeHttp.ServerResponse,
): Promise<void> => {
  const v2 = url.searchParams.get("list-type") === "2";
  const prefix = url.searchParams.get("prefix") ?? undefined;
  const delimiter = url.searchParams.get("delimiter") ?? undefined;
  const maxKeys = Math.min(
    Number(url.searchParams.get("max-keys") ?? 1000) || 1000,
    1000,
  );
  const continuationToken = url.searchParams.get("continuation-token");
  const startAfter = v2
    ? url.searchParams.get("start-after")
    : url.searchParams.get("marker");

  const listed = await bucket.list({
    prefix,
    delimiter,
    limit: maxKeys,
    ...(continuationToken !== null
      ? { cursor: continuationToken }
      : startAfter !== null
        ? { startAfter }
        : {}),
  } as runtime.R2ListOptions);

  const contents = listed.objects
    .map(
      (object) =>
        `<Contents>` +
        `<Key>${escapeXml(object.key)}</Key>` +
        `<LastModified>${object.uploaded.toISOString()}</LastModified>` +
        `<ETag>${escapeXml(object.httpEtag)}</ETag>` +
        `<Size>${object.size}</Size>` +
        `<StorageClass>STANDARD</StorageClass>` +
        `</Contents>`,
    )
    .join("");
  const prefixes = (listed.delimitedPrefixes ?? [])
    .map(
      (common) =>
        `<CommonPrefixes><Prefix>${escapeXml(common)}</Prefix></CommonPrefixes>`,
    )
    .join("");
  const cursor = listed.truncated ? listed.cursor : undefined;
  const pagination = v2
    ? `<KeyCount>${listed.objects.length + (listed.delimitedPrefixes?.length ?? 0)}</KeyCount>` +
      (cursor
        ? `<NextContinuationToken>${escapeXml(cursor)}</NextContinuationToken>`
        : "")
    : listed.truncated && listed.objects.length > 0
      ? `<NextMarker>${escapeXml(listed.objects[listed.objects.length - 1]!.key)}</NextMarker>`
      : "";

  respondXml(
    res,
    200,
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
      `<Name>${escapeXml(alias)}</Name>` +
      `<Prefix>${escapeXml(prefix ?? "")}</Prefix>` +
      `<MaxKeys>${maxKeys}</MaxKeys>` +
      `<IsTruncated>${listed.truncated}</IsTruncated>` +
      pagination +
      contents +
      prefixes +
      `</ListBucketResult>`,
  );
};

const deleteObjects = async (
  bucket: runtime.R2Bucket,
  body: Buffer,
  res: NodeHttp.ServerResponse,
): Promise<void> => {
  const keys = [...body.toString("utf8").matchAll(/<Key>([^<]*)<\/Key>/g)].map(
    (match) => unescapeXml(match[1]!),
  );
  if (keys.length > 0) {
    await bucket.delete(keys);
  }
  respondXml(
    res,
    200,
    `<DeleteResult>` +
      keys
        .map((key) => `<Deleted><Key>${escapeXml(key)}</Key></Deleted>`)
        .join("") +
      `</DeleteResult>`,
  );
};

const copyObject = async (
  bucket: Bucket,
  alias: string,
  key: string,
  rawSource: string,
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
): Promise<void> => {
  const source = parseCopySource(rawSource);
  if (source === undefined) {
    return respondError(res, 400, "InvalidArgument", rawSource);
  }
  const object = await (await bucket(source.alias)).get(source.key);
  if (object === null || !("body" in object)) {
    return respondError(res, 404, "NoSuchKey", source.key);
  }
  const replace = req.headers["x-amz-metadata-directive"] === "REPLACE";
  const meta = putMetadata(req.headers);
  const copied = await (
    await bucket(alias)
  ).put(key, await object.arrayBuffer(), {
    httpMetadata: replace ? meta.httpMetadata : object.httpMetadata,
    customMetadata: replace ? meta.customMetadata : object.customMetadata,
  } as runtime.R2PutOptions);
  respondXml(
    res,
    200,
    `<CopyObjectResult>` +
      `<LastModified>${copied!.uploaded.toISOString()}</LastModified>` +
      `<ETag>${escapeXml(copied!.httpEtag)}</ETag>` +
      `</CopyObjectResult>`,
  );
};

const uploadPart = async (
  bucket: Bucket,
  upload: MultipartUpload,
  partNumber: number,
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
): Promise<void> => {
  const source = req.headers["x-amz-copy-source"];
  let body: Buffer;
  if (typeof source === "string") {
    // UploadPartCopy — read the (possibly ranged) source through the binding
    const parsed = parseCopySource(source);
    if (parsed === undefined) {
      return respondError(res, 400, "InvalidArgument", source);
    }
    const range = parseRange(
      typeof req.headers["x-amz-copy-source-range"] === "string"
        ? req.headers["x-amz-copy-source-range"]
        : undefined,
    );
    const object = await (
      await bucket(parsed.alias)
    ).get(parsed.key, range ? { range } : undefined);
    if (object === null || !("body" in object)) {
      return respondError(res, 404, "NoSuchKey", parsed.key);
    }
    body = Buffer.from(await object.arrayBuffer());
  } else {
    body = await readBody(req);
  }
  await NodeFs.writeFile(
    NodePath.join(upload.directory, String(partNumber)),
    body,
  );
  const etag = `"${NodeCrypto.createHash("md5").update(body).digest("hex")}"`;
  if (typeof source === "string") {
    return respondXml(
      res,
      200,
      `<CopyPartResult>` +
        `<LastModified>${new Date().toISOString()}</LastModified>` +
        `<ETag>${escapeXml(etag)}</ETag>` +
        `</CopyPartResult>`,
    );
  }
  res.writeHead(200, { etag }).end();
};

const completeMultipartUpload = async (
  bucket: runtime.R2Bucket,
  uploads: Map<string, MultipartUpload>,
  uploadId: string,
  upload: MultipartUpload,
  body: Buffer,
  res: NodeHttp.ServerResponse,
): Promise<void> => {
  // parts are assembled host-side and land as ONE simulator put, so R2's
  // equal-part-size rule (and multipart etag shape) never applies in dev
  const partNumbers = [
    ...body.toString("utf8").matchAll(/<PartNumber>(\d+)<\/PartNumber>/g),
  ].map((match) => Number(match[1]));
  const parts = await Promise.all(
    partNumbers.map((partNumber) =>
      NodeFs.readFile(NodePath.join(upload.directory, String(partNumber))),
    ),
  );
  const object = await bucket.put(upload.key, Buffer.concat(parts), {
    httpMetadata: upload.options.httpMetadata,
    customMetadata: upload.options.customMetadata,
  } as runtime.R2PutOptions);
  uploads.delete(uploadId);
  await NodeFs.rm(upload.directory, { recursive: true, force: true });
  respondXml(
    res,
    200,
    `<CompleteMultipartUploadResult>` +
      `<Bucket>${escapeXml(upload.alias)}</Bucket>` +
      `<Key>${escapeXml(upload.key)}</Key>` +
      `<ETag>${escapeXml(object!.httpEtag)}</ETag>` +
      `</CompleteMultipartUploadResult>`,
  );
};

// ── parsing & serialization helpers ──────────────────────────────────

/** `/{alias}` or `/{alias}/{key…}` (path-style, segments percent-encoded). */
const parsePath = (
  pathname: string,
): [alias: string | undefined, key: string | undefined] => {
  const path = pathname.replace(/^\/+/, "");
  if (path === "") return [undefined, undefined];
  const slash = path.indexOf("/");
  if (slash === -1) return [decodeURIComponent(path), undefined];
  const alias = decodeURIComponent(path.slice(0, slash));
  const key = path
    .slice(slash + 1)
    .split("/")
    .map(decodeURIComponent)
    .join("/");
  return [alias, key];
};

/** `x-amz-copy-source`: `[/]bucket/key…`, percent-encoded. */
const parseCopySource = (
  source: string,
): { alias: string; key: string } | undefined => {
  const [alias, key] = parsePath(
    source.startsWith("/") ? source : `/${source}`,
  );
  return alias !== undefined && key !== undefined && key !== ""
    ? { alias, key }
    : undefined;
};

/** `bytes=a-b` | `bytes=a-` | `bytes=-suffix` → R2 range. */
const parseRange = (
  header: string | undefined,
): { offset: number; length?: number } | { suffix: number } | undefined => {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return undefined;
  const [, start, end] = match;
  if (start === "" && end !== "") return { suffix: Number(end) };
  if (start !== "" && end === "") return { offset: Number(start) };
  if (start !== "" && end !== "") {
    return { offset: Number(start), length: Number(end) - Number(start) + 1 };
  }
  return undefined;
};

const putMetadata = (headers: NodeHttp.IncomingHttpHeaders): R2PutMetadata => {
  const httpMetadata: Record<string, string> = {};
  const customMetadata: Record<string, string> = {};
  const http = {
    "content-type": "contentType",
    "content-encoding": "contentEncoding",
    "content-disposition": "contentDisposition",
    "content-language": "contentLanguage",
    "cache-control": "cacheControl",
  } as const;
  for (const [name, target] of Object.entries(http)) {
    const value = headers[name];
    if (typeof value === "string") httpMetadata[target] = value;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith("x-amz-meta-") && typeof value === "string") {
      customMetadata[name.slice("x-amz-meta-".length)] = value;
    }
  }
  return { httpMetadata, customMetadata };
};

const objectHeaders = (object: runtime.R2Object): Record<string, string> => {
  const headers: Record<string, string> = {
    "content-length": String(object.size),
    "last-modified": object.uploaded.toUTCString(),
    etag: object.httpEtag,
    "accept-ranges": "bytes",
  };
  const meta = object.httpMetadata;
  if (meta?.contentType) headers["content-type"] = meta.contentType;
  if (meta?.contentEncoding) headers["content-encoding"] = meta.contentEncoding;
  if (meta?.contentDisposition) {
    headers["content-disposition"] = meta.contentDisposition;
  }
  if (meta?.contentLanguage) headers["content-language"] = meta.contentLanguage;
  if (meta?.cacheControl) headers["cache-control"] = meta.cacheControl;
  for (const [name, value] of Object.entries(object.customMetadata ?? {})) {
    headers[`x-amz-meta-${name}`] = value;
  }
  return headers;
};

const readBody = (req: NodeHttp.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const respondXml = (
  res: NodeHttp.ServerResponse,
  status: number,
  body: string,
): void => {
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
};

const respondError = (
  res: NodeHttp.ServerResponse,
  status: number,
  code: string,
  message: string,
): void => {
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(errorXml(code, message));
};

const errorXml = (code: string, message: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`;

// text-content escaping only — quotes are legal in XML text, and real
// S3 sends ETags with literal quotes (`<ETag>"hex"</ETag>`)
const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const unescapeXml = (value: string): string =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
