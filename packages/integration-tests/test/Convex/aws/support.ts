import { expect } from "@alchemy.run/test";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { SELF_HOSTED_FIXTURE_DIR, scratchApp } from "../support.ts";

/** The backend image tests run, pinned because Convex migrations only go forward. */
export const BACKEND_IMAGE =
  "ghcr.io/convex/convex-backend:latest@sha256:207cf95def42f01614b6e3af0af5c20d0dcaa5ff2adf258ee7bc9555576644fa";

/** A public Route 53 domain in the test account. Tests create hosts under it. */
export const TEST_DOMAIN = process.env.CONVEX_TEST_DOMAIN ?? "";

/** Paid suites run only when asked for, and only with a domain for their certificate. */
export const skipPaid = process.env.CONVEX_TEST_AWS !== "1" || TEST_DOMAIN === "";

/** A private copy of the self-hosted fixture app. */
export const selfHostedApp = (name: string) => scratchApp(name, SELF_HOSTED_FIXTURE_DIR);

const messages = anyApi.messages!;

const withClient = <A, E, R>(url: string, use: (client: ConvexClient) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new ConvexClient(url)),
    use,
    (client) => Effect.promise(() => client.close()),
  );

const texts = (client: ConvexClient) =>
  Effect.promise(() => client.query(messages.list!, {})).pipe(
    Effect.map((rows: Array<{ text: string }>) => rows.map((row) => row.text)),
  );

/**
 * Proves a deployed backend works for a real client: a query, a mutation seen
 * through a live websocket subscription, and an HTTP action on the site host.
 * `holdSocketSeconds` proves the load balancer leaves an idle socket open.
 */
export const assertRuntime = (input: {
  url: string;
  /** Checks the HTTP action on the site host, for an app that defines one. */
  siteUrl?: string;
  text: string;
  holdSocketSeconds?: number;
}) =>
  withClient(input.url, (client) =>
    Effect.gen(function* () {
      const seen = Effect.callback<void>((resume) => {
        const unsubscribe = client.onUpdate(messages.list!, {}, (rows: Array<{ text: string }>) => {
          if (rows.some((row) => row.text === input.text)) resume(Effect.void);
        });
        return Effect.sync(() => unsubscribe());
      }).pipe(Effect.timeout("30 seconds"));
      const add = (text: string) => Effect.promise(() => client.mutation(messages.add!, { text }));

      yield* Effect.all([seen, add(input.text)], { concurrency: "unbounded" });
      expect(yield* texts(client)).toContain(input.text);

      if (input.siteUrl !== undefined) {
        const http = yield* HttpClient.HttpClient;
        const site = yield* http.get(`${input.siteUrl}/hello`);
        expect(site.status).toBe(200);
        expect(yield* site.text).toBe("hello from an http action");
      }

      if (input.holdSocketSeconds !== undefined) {
        yield* Effect.sleep(`${input.holdSocketSeconds} seconds`);
        const later = `${input.text} after waiting`;
        yield* add(later);
        expect(yield* texts(client)).toContain(later);
        expect(client.connectionState().isWebSocketConnected).toBe(true);
      }
    }),
  );

/** The rows a fresh client sees. */
export const listMessages = (url: string) => withClient(url, texts);
