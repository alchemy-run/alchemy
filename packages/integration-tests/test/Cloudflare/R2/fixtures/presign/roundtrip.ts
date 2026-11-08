import { expect } from "@alchemy.run/test";
import type * as Presign from "@distilled.cloud/aws/Presign";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";

class UnexpectedStatus extends Data.TaggedError("UnexpectedStatus")<{
  message: string;
}> {}

// Bounded: rides out cold starts and (live) API-token propagation, which can
// take several seconds before R2 accepts the token-derived S3 credentials.
const retry = Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(20)]);

const expectStatus = (request: HttpClientRequest.HttpClientRequest, status: number) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.execute(request);
    const body = yield* res.text;
    if (res.status !== status) {
      return yield* new UnexpectedStatus({
        message: `${request.method} ${request.url} → ${res.status}: ${body.slice(0, 500)}`,
      });
    }
    return body;
  });

const until = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
  effect.pipe(Effect.retry({ schedule: retry }), Effect.orDie);

const json = <T>(url: string) =>
  until(
    expectStatus(HttpClientRequest.get(url), 200).pipe(Effect.map((body) => JSON.parse(body) as T)),
  );

/**
 * Drive a deployed presign fixture (`routes.ts`) end to end: upload through
 * a presigned PUT URL as an unauthenticated client, read it back through
 * the Worker's native binding and through a presigned GET URL, and check
 * that a pinned Content-Type is enforced.
 */
export const presignRoundTrip = (workerUrl: string, key: string) =>
  Effect.gen(function* () {
    const { url: putUrl } = yield* json<{ url: string }>(
      `${workerUrl}/presign-put?key=${encodeURIComponent(key)}&contentType=text/plain`,
    );

    yield* until(
      expectStatus(
        HttpClientRequest.put(putUrl).pipe(
          HttpClientRequest.setBody(HttpBody.text("uploaded via presigned url", "text/plain")),
        ),
        200,
      ),
    );

    const read = yield* json<{ value: string | null; contentType: string }>(
      `${workerUrl}/read?key=${encodeURIComponent(key)}`,
    );
    expect(read.value).toBe("uploaded via presigned url");
    expect(read.contentType).toBe("text/plain");

    // The signed Content-Type is enforced
    const client = yield* HttpClient.HttpClient;
    const wrongType = yield* client.execute(
      HttpClientRequest.put(putUrl).pipe(
        HttpClientRequest.setBody(HttpBody.text("{}", "application/json")),
      ),
    );
    expect(wrongType.status).toBe(403);

    const { url: getUrl } = yield* json<{ url: string }>(
      `${workerUrl}/presign-get?key=${encodeURIComponent(key)}&contentType=application/octet-stream`,
    );
    const downloaded = yield* client.get(getUrl);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers["content-type"]).toBe("application/octet-stream");
    expect(yield* downloaded.text).toBe("uploaded via presigned url");

    return { putUrl, getUrl };
  });

const presign = (url: string, input: object) =>
  until(
    expectStatus(
      HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(input)),
      200,
    ).pipe(Effect.map((body) => JSON.parse(body) as Presign.PresignedRequest)),
  );

/**
 * Drive the bindings' S3 fields through a deployed presign fixture
 * (`routes.ts`): an upload pinned to its size that may not overwrite, and a
 * download with a signed `Content-Disposition` and `Range`.
 */
export const presignFields = (workerUrl: string, key: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const body = "exactly this many bytes";
    const upload = yield* presign(`${workerUrl}/presign-put`, {
      Key: key,
      ContentType: "text/plain",
      ContentLength: body.length,
      IfNoneMatch: "*",
    });
    expect(upload.headers).toEqual({
      "content-length": String(body.length),
      "content-type": "text/plain",
      "if-none-match": "*",
    });
    const put = (text: string) =>
      HttpClientRequest.put(upload.url).pipe(
        HttpClientRequest.setHeader("if-none-match", "*"),
        HttpClientRequest.setBody(HttpBody.text(text, "text/plain")),
      );

    const resized = yield* client.execute(put(`${body}!`));
    expect(resized.status).toBe(403);
    yield* until(expectStatus(put(body), 200));
    const overwrite = yield* client.execute(put(body));
    expect(overwrite.status).toBe(412);

    const download = yield* presign(`${workerUrl}/presign-get`, {
      Key: key,
      ResponseContentDisposition: 'attachment; filename="a b.txt"',
      Range: "bytes=0-6",
    });
    expect(download.headers).toEqual({ range: "bytes=0-6" });
    const ranged = yield* client.execute(
      HttpClientRequest.get(download.url).pipe(HttpClientRequest.setHeaders(download.headers)),
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers["content-disposition"]).toBe('attachment; filename="a b.txt"');
    expect(yield* ranged.text).toBe("exactly");
    const unranged = yield* client.execute(HttpClientRequest.get(download.url));
    expect(unranged.status).toBe(403);
  });
