import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

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

test.provider.skipIf(!runLifecycle)(
  "GetPage and GetPost round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const page = yield* GCP.Blogger.Page("About", {
            blogId: blogId!,
            title: "About",
            content: "<p>hello</p>",
            status: "DRAFT",
          });
          const post = yield* GCP.Blogger.Post("Launch", {
            blogId: blogId!,
            title: "Launch",
            content: "<p>hello</p>",
            status: "DRAFT",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* page.pageId;
              yield* post.postId;
              const getPage = yield* GCP.Blogger.GetPage(page);
              const getPost = yield* GCP.Blogger.GetPost(post);
              return Effect.fn(function* () {
                const pageMeta = yield* getPage({ view: "ADMIN" });
                const postMeta = yield* getPost({
                  fetchBody: true,
                  view: "ADMIN",
                });
                return { pageMeta, postMeta };
              });
            }),
          );
          return { page, post, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.pageMeta.id).toEqual(out.page.pageId);
      expect(out.probe.pageMeta.title).toContain("About");
      expect(out.probe.postMeta.id).toEqual(out.post.postId);
      expect(out.probe.postMeta.title).toContain("Launch");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
