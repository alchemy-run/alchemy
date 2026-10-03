/**
 * Internal Kubernetes API client: transport-agnostic server-side apply and
 * kind discovery for arbitrary (CRD) manifests. Powers
 * `Kubernetes.Manifest`, `Kubernetes.Deployment`, `Kubernetes.Job`,
 * `Kubernetes.HelmChart`, and the `AWS.EKS.Cluster` kubernetes-object
 * binding channel. Not exported from the Kubernetes index.
 *
 * Authentication is delegated to the connection's {@link ClusterAdapter}:
 * every request mints headers through the resolved
 * {@link ClusterTransport}, so short-lived tokens (EKS SigV4 presigns,
 * exec-plugin credentials) stay fresh.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as https from "node:https";
import { isPlainObject, unwrapRedacted } from "../../Util/data.ts";
import {
  findClusterAdapter,
  type ClusterTransport,
} from "../ClusterAdapter.ts";
import type { Connection } from "../Connection.ts";
import {
  buildKubernetesObjectPathWithSpec,
  chunkByApplyRank,
  DEFAULT_APPLY_RANK,
  kubernetesObjectKey,
  lookupKubernetesKindSpec,
  sortRefsForDelete,
  toKubernetesObjectRef,
  type KubernetesObjectDefinition,
  type KubernetesObjectKindSpec,
  type KubernetesObjectRef,
} from "./objects.ts";

export class KubernetesApiError extends Data.TaggedError("KubernetesApiError")<{
  method: string;
  path: string;
  statusCode: number;
  body: string;
}> {
  override get message(): string {
    return `${this.method} ${this.path} responded ${this.statusCode}: ${
      this.body.length > 0 ? this.body.slice(0, 1000) : "(empty body)"
    }`;
  }
}

const fieldManager = "alchemy";

/** Deadline for auth-header minting and for each HTTP attempt. */
const requestTimeout = "10 seconds";

// ponytail: secrets shorter than 4 characters are not scrubbed. replaceAll
// on a tiny needle shreds unrelated JSON. Upgrade path: a structured redaction
// pass if a provider ever stores sub-4-character secrets.
const minScrubLength = 4;

export const collectRedactedSecrets = (
  value: unknown,
  out: string[] = [],
): string[] => {
  if (Redacted.isRedacted(value)) {
    const inner = Redacted.value(value);
    if (typeof inner === "string") {
      if (inner.length >= minScrubLength) out.push(inner);
    } else {
      collectRedactedSecrets(inner, out);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRedactedSecrets(item, out);
    return out;
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) collectRedactedSecrets(item, out);
  }
  return out;
};

export const scrubSecrets = (
  text: string,
  secrets: readonly string[],
): string => {
  let out = text;
  for (const secret of secrets) {
    const forms = [secret, Buffer.from(secret).toString("base64")];
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) forms.push(escaped);
    for (const form of forms) {
      if (form.length >= minScrubLength)
        out = out.replaceAll(form, "<redacted>");
    }
  }
  return out;
};

/**
 * Resolve the {@link ClusterTransport} for a connection through its
 * registered adapter.
 */
export const connectCluster = (connection: Connection) =>
  findClusterAdapter(connection.auth.kind).pipe(
    Effect.flatMap((adapter) => adapter.connect(connection)),
  );

const requestJson = Effect.fn(function* ({
  transport,
  method,
  path,
  body,
  secrets,
}: {
  transport: ClusterTransport;
  method: string;
  path: string;
  body?: Record<string, unknown>;
  /** Plaintext already unwrapped upstream (Helm render). Scrub these too. */
  secrets?: readonly string[];
}) {
  // Outside the attempt retry: a hung token mint must not be retried as
  // if it were a refused connection.
  const headers = yield* transport.headers.pipe(Effect.timeout(requestTimeout));
  const url = new URL(path, transport.endpoint);
  const redactions = yield* Effect.sync(() => [
    ...(body ? collectRedactedSecrets(body) : []),
    ...(secrets ?? []),
  ]);
  // JSON.stringify(Redacted) emits the display placeholder. Unwrap only at
  // the wire so plans and state keep the wrapper.
  const payload = body
    ? yield* Effect.sync(() => JSON.stringify(unwrapRedacted(body)))
    : undefined;

  return yield* Effect.callback<unknown, KubernetesApiError | Error>(
    (resume, signal) => {
      let settled = false;
      const finish = (
        effect: Effect.Effect<unknown, KubernetesApiError | Error>,
      ) => {
        if (settled || signal.aborted) return;
        settled = true;
        resume(effect);
      };
      const request = https.request(
        {
          signal,
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method,
          headers: {
            ...headers,
            Accept: "application/json",
            ...(payload
              ? {
                  "Content-Type": "application/apply-patch+yaml",
                  "Content-Length": Buffer.byteLength(payload),
                }
              : {}),
          },
          ...(transport.certificateAuthorityData
            ? {
                ca: Buffer.from(
                  transport.certificateAuthorityData,
                  "base64",
                ).toString("utf8"),
              }
            : {}),
          ...(transport.clientCert
            ? {
                cert: transport.clientCert.certificate,
                key: transport.clientCert.key,
              }
            : {}),
          ...(transport.insecureSkipTlsVerify
            ? { rejectUnauthorized: false }
            : {}),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on("error", (error) => {
            finish(Effect.fail(error));
          });
          response.on("aborted", () => {
            finish(
              Effect.fail(
                new Error(`Kubernetes ${method} ${path} response aborted`),
              ),
            );
          });
          response.on("end", () => {
            const rawBody = Buffer.concat(chunks).toString("utf8");
            const statusCode = response.statusCode ?? 500;

            if (statusCode < 200 || statusCode >= 300) {
              // Error bodies can echo the request. Scrub only failures —
              // a successful dry-run is the object we compare for drift.
              const responseBody = scrubSecrets(rawBody, redactions);
              finish(
                Effect.fail(
                  new KubernetesApiError({
                    method,
                    path,
                    statusCode,
                    body: responseBody,
                  }),
                ),
              );
              return;
            }

            const responseBody = rawBody;

            if (!responseBody.trim()) {
              finish(Effect.succeed(undefined));
              return;
            }

            try {
              finish(Effect.succeed(JSON.parse(responseBody)));
            } catch {
              finish(Effect.succeed(responseBody));
            }
          });
        },
      );

      request.on("error", (error) => {
        finish(
          Effect.fail(
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
      });
      if (payload) request.write(payload);
      request.end();
      // Bun's TLS client ignores AbortSignal and ClientRequest#destroy while
      // the response is pending; destroying the socket is what releases it.
      const stop = () => {
        request.destroy();
        request.socket?.destroy();
      };
      signal.addEventListener("abort", stop, { once: true });
      return Effect.sync(() => {
        signal.removeEventListener("abort", stop);
        stop();
      });
    },
  ).pipe(
    Effect.timeout(requestTimeout),
    Effect.mapError((error) =>
      error instanceof KubernetesApiError
        ? error
        : new Error(
            `Failed Kubernetes ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`,
          ),
    ),
    // Transport-level failures (ECONNREFUSED/ECONNRESET/ETIMEDOUT/DNS,
    // the per-attempt deadline) are transient — a fresh managed endpoint's
    // load balancer can refuse connections for a short window after the
    // cluster reports ready. Every request here is idempotent (GET / SSA
    // PATCH / DELETE), so retry them; HTTP errors (KubernetesApiError)
    // are handled by the callers.
    Effect.retry({
      while: (e): boolean => !(e instanceof KubernetesApiError),
      schedule: Schedule.max([
        Schedule.spaced("5 seconds"),
        Schedule.recurs(8),
      ]),
    }),
  );
});

// ─────────────────────────────────────────────────────── kind discovery ──

interface ApiResourceList {
  resources?: {
    name?: string;
    kind?: string;
    namespaced?: boolean;
  }[];
}

// One resolution per (endpoint, apiVersion, kind) per process. Plain cached
// values (no finalizers), so module scope is safe.
const discoveredKinds = new Map<string, KubernetesObjectKindSpec>();

/**
 * Resolve the REST mapping (plural + scope) for an arbitrary kind: static
 * table fast path, then the Kubernetes discovery API (`/apis/{g}/{v}` or
 * `/api/v1`). This is what lets `Kubernetes.Manifest` apply any CRD.
 */
export const resolveKindSpec = Effect.fn(function* ({
  transport,
  input,
}: {
  transport: ClusterTransport;
  input: Pick<KubernetesObjectRef, "apiVersion" | "kind">;
}) {
  const staticSpec = lookupKubernetesKindSpec(input);
  if (staticSpec) return staticSpec;

  const cacheKey = `${transport.endpoint}|${input.apiVersion}|${input.kind}`;
  const cached = discoveredKinds.get(cacheKey);
  if (cached) return cached;

  const discoveryPath = input.apiVersion.includes("/")
    ? `/apis/${input.apiVersion}`
    : `/api/${input.apiVersion}`;

  const listed = (yield* requestJson({
    transport,
    method: "GET",
    path: discoveryPath,
  })) as ApiResourceList;

  const resource = listed.resources?.find(
    (candidate) =>
      candidate.kind === input.kind &&
      typeof candidate.name === "string" &&
      !candidate.name.includes("/"),
  );

  if (!resource?.name) {
    return yield* Effect.fail(
      new KubernetesApiError({
        method: "GET",
        path: discoveryPath,
        statusCode: 404,
        body: `Kind '${input.kind}' not found in API group '${input.apiVersion}'`,
      }),
    );
  }

  const spec: KubernetesObjectKindSpec = {
    plural: resource.name,
    scope: resource.namespaced ? "Namespaced" : "Cluster",
    applyRank: DEFAULT_APPLY_RANK,
  };
  discoveredKinds.set(cacheKey, spec);
  return spec;
});

const buildPath = Effect.fn(function* ({
  transport,
  object,
}: {
  transport: ClusterTransport;
  object: KubernetesObjectRef;
}) {
  const spec = yield* resolveKindSpec({ transport, input: object });
  return yield* Effect.try({
    try: () => buildKubernetesObjectPathWithSpec(object, spec),
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });
});

// ─────────────────────────────────────────────────────────── object ops ──

export const readObject = Effect.fn(function* ({
  transport,
  object,
}: {
  transport: ClusterTransport;
  object: KubernetesObjectRef;
}) {
  return yield* requestJson({
    transport,
    method: "GET",
    path: yield* buildPath({ transport, object }),
  });
});

export const applyObject = Effect.fn(function* ({
  transport,
  object,
  dryRun,
  secrets,
}: {
  transport: ClusterTransport;
  object: KubernetesObjectDefinition;
  /** `dryRun=All` — the apiserver returns the merged object and writes nothing. */
  dryRun?: boolean;
  /** Plaintext secrets no longer wrapped in the object (rendered Helm values). */
  secrets?: readonly string[];
}) {
  const basePath = yield* buildPath({
    transport,
    object: toKubernetesObjectRef(object),
  });
  const path = `${basePath}?fieldManager=${fieldManager}&force=true${dryRun ? "&dryRun=All" : ""}`;

  const applied = requestJson({
    transport,
    method: "PATCH",
    path,
    body: object,
    secrets,
  });
  // A freshly provisioned cluster's API server briefly 5xxes while warming
  // up, and the creator's bootstrap access can propagate asynchronously
  // (401/403 in the first minute). Dry-run is a read: a 403 there is
  // permanent (get/list/watch), so don't sit on that retry.
  if (dryRun) return yield* applied;
  return yield* applied.pipe(
    Effect.retry({
      while: (e): boolean =>
        e instanceof KubernetesApiError &&
        (e.statusCode >= 500 ||
          e.statusCode === 429 ||
          e.statusCode === 401 ||
          e.statusCode === 403),
      schedule: Schedule.max([
        Schedule.spaced("6 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );
});

export const deleteObject = Effect.fn(function* ({
  transport,
  object,
}: {
  transport: ClusterTransport;
  object: KubernetesObjectRef;
}) {
  yield* buildPath({ transport, object }).pipe(
    Effect.flatMap((path) =>
      requestJson({
        transport,
        method: "DELETE",
        // batch/v1 Jobs orphan their pods on DELETE unless a propagation
        // policy is set; Background matches kubectl's default.
        path: `${path}?propagationPolicy=Background`,
      }),
    ),
    Effect.catchIf(
      (error): error is KubernetesApiError =>
        error instanceof KubernetesApiError,
      (error) => (error.statusCode === 404 ? Effect.void : Effect.fail(error)),
    ),
  );
});

export const reconcileObjects = Effect.fn(function* ({
  transport,
  previousObjects,
  desiredObjects,
  secrets,
}: {
  transport: ClusterTransport;
  previousObjects: ReadonlyArray<KubernetesObjectRef>;
  desiredObjects: ReadonlyArray<KubernetesObjectDefinition>;
  /** Plaintext secrets to scrub from apply errors. See {@link applyObject}. */
  secrets?: readonly string[];
}) {
  const desiredRefs = desiredObjects.map(toKubernetesObjectRef);
  const desiredKeys = new Set(desiredRefs.map(kubernetesObjectKey));

  const removedObjects = previousObjects.filter(
    (object) => !desiredKeys.has(kubernetesObjectKey(object)),
  );

  for (const object of sortRefsForDelete(removedObjects)) {
    yield* deleteObject({
      transport,
      object,
    });
  }

  for (const chunk of chunkByApplyRank(desiredObjects)) {
    yield* Effect.forEach(
      chunk,
      (object) =>
        applyObject({
          transport,
          object,
          secrets,
        }),
      {
        concurrency: "unbounded",
      },
    );
  }

  return desiredRefs;
});

export const deleteObjects = Effect.fn(function* ({
  transport,
  objects,
}: {
  transport: ClusterTransport;
  objects: ReadonlyArray<KubernetesObjectRef>;
}) {
  for (const object of sortRefsForDelete(objects)) {
    yield* deleteObject({
      transport,
      object,
    });
  }
});
