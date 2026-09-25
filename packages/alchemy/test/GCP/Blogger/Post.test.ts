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

const waitUntilGone = (parentBlogId: string, postId: string) =>
  blogger.getPosts({ blogId: parentBlogId, postId }).pipe(
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
  "getPosts on a missing post fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        blogger.getPosts({
          blogId: "0000000000000000000",
          postId: "alchemy-missing-post",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_BLOGGER)(
  "insertPosts without Blogger access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        blogger.insertPosts({
          blogId: "0000000000000000000",
          isDraft: true,
          body: {
            title: "Alchemy Post Probe",
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
  "create, update, and delete a post",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Blogger.Post("Launch", {
            blogId: blogId!,
            title: "Launch",
            content: "<p>hello</p>",
            status: "DRAFT",
            labels: ["news"],
          });
        }),
      );

      expect(created.postId.length).toBeGreaterThan(0);
      expect(created.blogId).toEqual(blogId);
      expect(created.title).toEqual("Launch");
      expect(created.content).toContain("hello");
      expect(created.labels).toContain("news");

      const fetched = yield* blogger.getPosts({
        blogId: created.blogId,
        postId: created.postId,
        fetchBody: true,
        view: "ADMIN",
      });
      expect(fetched.id).toEqual(created.postId);
      expect(fetched.title).toContain("[alchemy ");
      expect(fetched.customMetaData).toContain("alchemy");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Blogger.Post("Launch", {
            blogId: created.blogId,
            postId: created.postId,
            title: "Launch",
            content: "<p>updated</p>",
            status: "DRAFT",
            labels: ["news", "release"],
          });
        }),
      );

      expect(updated.postId).toEqual(created.postId);
      expect(updated.content).toContain("updated");
      expect(updated.labels).toEqual(
        expect.arrayContaining(["news", "release"]),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.blogId, created.postId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
