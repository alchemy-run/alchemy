import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { WaitUntilResources } from "./fixtures/wait-until/stack.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

/** Send a request, retrying until the freshly started workerd serves a 200. */
const send = Effect.fn(function* (request: HttpClientRequest.HttpClientRequest) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.text
        : response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(new Error(`${request.url}: ${response.status}: ${body}`)),
            ),
          ),
    ),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 15 }),
  );
});

const journalEntries = Effect.fn(function* (url: string, label: string) {
  return yield* send(HttpClientRequest.get(`${url}/lifetime/entries/${label}`)).pipe(
    Effect.map((text) => (JSON.parse(text) as { entries: string[] }).entries),
    Effect.repeat({
      schedule: Schedule.spaced("500 millis"),
      until: (entries) => entries.length >= 2,
      times: 30,
    }),
  );
});

/**
 * Cloudflare delivers scheduled, email and tail events only on its own
 * schedule, through Email Routing, or after a producer's invocation. The
 * local runtime triggers each directly, through the same bridge as a
 * deployed Worker.
 */
test.provider(
  "the event's scope stays open for waitUntil work in scheduled, email and tail events",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { url, producerUrl } = yield* stack.deploy(WaitUntilResources);
      expect(url).toMatch(/^http:\/\/localhost:\d+$/);

      // A scheduled event at `time`, a minute, journals under `cron-<time>`.
      const time = Math.floor(Date.now() / 60_000) * 60_000;
      expect(
        yield* send(
          HttpClientRequest.post(
            `${url}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}&time=${time}`,
          ),
        ),
      ).toBe("ok");
      expect(yield* journalEntries(url, `cron-${time}`)).toEqual([
        `cron-${time}:open`,
        `cron-${time}:released`,
      ]);

      // An email's subject is its label.
      const email = `email-${time}`;
      yield* send(
        HttpClientRequest.post(
          `${url}/cdn-cgi/local/email?from=sender@example.com&to=inbox@example.com`,
        ).pipe(
          HttpClientRequest.bodyText(
            [
              "From: sender@example.com",
              "To: inbox@example.com",
              `Subject: ${email}`,
              `Message-ID: <${email}@example.com>`,
              "",
              "body",
            ].join("\r\n"),
          ),
        ),
      );
      expect(yield* journalEntries(url, email)).toEqual([`${email}:open`, `${email}:released`]);

      // The producer's log line names the label its trace carries.
      const tail = `tail-${time}`;
      expect(yield* send(HttpClientRequest.get(`${producerUrl}/${tail}`))).toBe("logged");
      expect(yield* journalEntries(url, tail)).toEqual([`${tail}:open`, `${tail}:released`]);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 180_000,
  },
);
