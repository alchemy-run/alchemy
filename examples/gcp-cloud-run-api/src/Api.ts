import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ApiKey, Links } from "./resources.ts";

/** Base62 so codes stay short and URL-safe. */
const ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const newCode = () =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(7)),
    (byte) => ALPHABET[byte % ALPHABET.length],
  ).join("");

/** Constant-time comparison so response timing does not leak the key. */
const sameKey = (expected: string, given: string | undefined) => {
  if (given === undefined || given.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index++) {
    diff |= expected.charCodeAt(index) ^ given.charCodeAt(index);
  }
  return diff === 0;
};

interface Link {
  url: string;
  clicks: number;
  createdAt: string;
}

/**
 * A link shortener on Cloud Run.
 *
 * This is the shape of most GCP web services: one Cloud Run container,
 * Firestore for state, Secret Manager for the credential the container
 * needs at runtime. Nothing is wired by hand — each `yield*` of a binding
 * grants the matching IAM role on the service's runtime service account
 * and injects whatever the call needs into the revision.
 *
 * - `POST /links` — mint a code for a URL (requires `x-api-key`).
 * - `GET /l/:code` — redirect and count the click.
 * - `GET /links/:code` — read the link back.
 * - `DELETE /links/:code` — retire a code (requires `x-api-key`).
 *
 * `invokerIamDisabled: true` makes the service publicly reachable, which
 * a link shortener has to be. Drop it and Cloud Run requires a signed
 * Google identity token on every request.
 */
export default class Api extends GCP.Function<Api>()(
  "Api",
  {
    main: import.meta.url,
    location: "us-central1",
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    const links = yield* Links;
    const apiKey = yield* ApiKey;

    // Each binding grants one role on the runtime service account:
    // datastore.viewer / datastore.user for the document calls, and
    // secretmanager.secretAccessor on the API key secret only.
    const getDocument = yield* GCP.Firestore.GetDocument(links);
    const patchDocument = yield* GCP.Firestore.PatchDocument(links);
    const deleteDocument = yield* GCP.Firestore.DeleteDocument(links);
    const accessApiKey = yield* GCP.SecretManager.AccessSecretVersion(apiKey);

    const readLink = (code: string) =>
      getDocument({ documentPath: `links/${code}` }).pipe(
        Effect.map((document): Link | undefined => {
          const fields = document.fields ?? {};
          const url = fields.url?.stringValue;
          if (url === undefined) return undefined;
          return {
            url,
            clicks: Number(fields.clicks?.integerValue ?? "0"),
            createdAt: fields.createdAt?.timestampValue ?? "",
          };
        }),
        // A missing document is a 404 here, not a failure.
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.orDie,
      );

    const writeLink = (code: string, link: Link) =>
      patchDocument({
        documentPath: `links/${code}`,
        body: {
          fields: {
            url: { stringValue: link.url },
            clicks: { integerValue: String(link.clicks) },
            createdAt: { timestampValue: link.createdAt },
          },
        },
      }).pipe(Effect.orDie);

    /**
     * Secret Manager holds the key; the container reads the `latest`
     * version on demand. Until someone adds a version the API cannot
     * authenticate anyone, so say so instead of failing open.
     */
    const authorize = (request: HttpServerRequest) =>
      accessApiKey().pipe(
        Effect.map((version) => {
          const data = version.payload?.data;
          if (data === undefined) return "unconfigured" as const;
          return sameKey(atob(data), request.headers["x-api-key"])
            ? ("ok" as const)
            : ("denied" as const);
        }),
        Effect.catchTag("NotFound", () =>
          Effect.succeed("unconfigured" as const),
        ),
        Effect.orDie,
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const segments = url.pathname.split("/").filter(Boolean);

        if (request.method === "GET" && segments.length === 0) {
          return HttpServerResponse.text("ok");
        }

        // Mint a code. 62^7 keeps collisions negligible; a shortener that
        // cannot tolerate one at all wants a Firestore transaction with a
        // `currentDocument.exists: false` precondition instead.
        if (request.method === "POST" && url.pathname === "/links") {
          const auth = yield* authorize(request);
          if (auth !== "ok") {
            return yield* HttpServerResponse.json(
              {
                error:
                  auth === "unconfigured"
                    ? "no api key version has been added to the secret"
                    : "invalid api key",
              },
              { status: auth === "unconfigured" ? 503 : 401 },
            );
          }

          const body = (yield* request.json) as { url?: string };
          if (!body.url) {
            return yield* HttpServerResponse.json(
              { error: "url is required" },
              { status: 400 },
            );
          }

          const code = newCode();
          yield* writeLink(code, {
            url: body.url,
            clicks: 0,
            createdAt: new Date().toISOString(),
          });

          return yield* HttpServerResponse.json(
            { code, shortUrl: `${url.origin}/l/${code}` },
            { status: 201 },
          );
        }

        // Follow a link. The click counter is a read-modify-write, which
        // is fine for a counter nobody bills on; a Firestore transaction
        // is the answer when the count has to be exact.
        if (request.method === "GET" && segments[0] === "l" && segments[1]) {
          const link = yield* readLink(segments[1]);
          if (link === undefined) {
            return yield* HttpServerResponse.json(
              { error: "unknown code" },
              { status: 404 },
            );
          }

          yield* writeLink(segments[1], {
            ...link,
            clicks: link.clicks + 1,
          });

          return HttpServerResponse.empty({
            status: 302,
            headers: { location: link.url },
          });
        }

        if (
          request.method === "GET" &&
          segments[0] === "links" &&
          segments[1]
        ) {
          const link = yield* readLink(segments[1]);
          if (link === undefined) {
            return yield* HttpServerResponse.json(
              { error: "unknown code" },
              { status: 404 },
            );
          }
          return yield* HttpServerResponse.json({ code: segments[1], ...link });
        }

        if (
          request.method === "DELETE" &&
          segments[0] === "links" &&
          segments[1]
        ) {
          const auth = yield* authorize(request);
          if (auth !== "ok") {
            return yield* HttpServerResponse.json(
              { error: "invalid api key" },
              { status: 401 },
            );
          }
          yield* deleteDocument({ documentPath: `links/${segments[1]}` }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.orDie,
          );
          return HttpServerResponse.empty({ status: 204 });
        }

        return yield* HttpServerResponse.json(
          { error: "not found" },
          { status: 404 },
        );
      }),
    };
  }).pipe(
    Effect.provide([
      GCP.Firestore.GetDocumentHttp,
      GCP.Firestore.PatchDocumentHttp,
      GCP.Firestore.DeleteDocumentHttp,
      GCP.SecretManager.AccessSecretVersionHttp,
    ]),
  ),
) {}
