import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as blogger from "@distilled.cloud/gcp/blogger_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const blogId = process.env.GCP_TEST_BLOGGER_BLOG_ID;

const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  !!process.env.GCP_TEST_BLOGGER &&
  !!blogId;

const waitUntilGone = (parentBlogId: string, pageId: string) =>
  blogger.getPages({ blogId: parentBlogId, pageId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getPages on a missing page fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        blogger.getPages({
          blogId: "0000000000000000000",
          pageId: "alchemy-missing-page",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_BLOGGER)(
  "insertPages without Blogger access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        blogger.insertPages({
          blogId: "0000000000000000000",
          isDraft: true,
          body: {
            title: "Alchemy Page Probe",
            content: "<p>probe</p>",
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a page",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Blogger.Page("About", {
            blogId: blogId!,
            title: "About",
            content: "<p>hello</p>",
            status: "DRAFT",
          });
        }),
      );

      expect(created.pageId.length).toBeGreaterThan(0);
      expect(created.blogId).toEqual(blogId);
      expect(created.title).toEqual("About");
      expect(created.content).toContain("hello");

      const fetched = yield* blogger.getPages({
        blogId: created.blogId,
        pageId: created.pageId,
        view: "ADMIN",
      });
      expect(fetched.id).toEqual(created.pageId);
      expect(fetched.title).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Blogger.Page("About", {
            blogId: created.blogId,
            pageId: created.pageId,
            title: "About",
            content: "<p>updated</p>",
            status: "DRAFT",
          });
        }),
      );

      expect(updated.pageId).toEqual(created.pageId);
      expect(updated.content).toContain("updated");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.blogId, created.pageId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
