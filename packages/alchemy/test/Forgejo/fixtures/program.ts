import * as Forgejo from "@/Forgejo/index.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Repository, OtherRepository } from "./repository.ts";

export const program = Effect.gen(function* () {
  const repo = yield* Repository;
  const other = yield* OtherRepository;
  const rotation = yield* Config.String("FORGEJO_TEST_ROTATION").pipe(
    Config.withDefault("one"),
  );
  const read = yield* Forgejo.ReadRepository(repo, { rotation });
  yield* Forgejo.ReadRepository(repo, { rotation });
  const write = yield* Forgejo.WriteRepository(repo);
  const readWrite = yield* Forgejo.ReadWriteRepository(repo);
  const issues = yield* Forgejo.ReadIssues(repo);
  const writeIssues = yield* Forgejo.WriteIssues(repo);
  const readWriteIssues = yield* Forgejo.ReadWriteIssues(repo);
  const otherRead = yield* Forgejo.ReadRepository(other);
  const signingSecret = yield* Config.Redacted(
    "FORGEJO_TEST_WEBHOOK_SECRET",
  ).pipe(Config.option);
  yield* Forgejo.RepositoryEventSource(
    repo,
    {
      events: ["push", "issues"],
      secret: Option.getOrUndefined(signingSecret),
    },
    (event) =>
      (event.name === "push"
        ? writeIssues.create({
            title: `received push ${event.id}`,
            body: event.payload.ref,
          })
        : event.payload.action === "fanout-retry"
          ? writeIssues.createComment({
              index: event.payload.issue.number,
              body: `attempted delivery ${event.id}`,
            })
          : event.payload.action === "opened"
            ? writeIssues.createComment({
                index: event.payload.issue.number,
                body: `received issues ${event.id}`,
              })
            : Effect.void
      ).pipe(Effect.asVoid, Effect.orDie),
  );
  yield* Forgejo.RepositoryEventSource(
    repo,
    {
      events: ["issues", "push"],
      secret: Option.getOrUndefined(signingSecret),
    },
    (event) =>
      Effect.gen(function* () {
        if (event.name !== "issues") return;
        if (event.payload.action === "opened") {
          yield* writeIssues
            .createComment({
              index: event.payload.issue.number,
              body: `audited issues ${event.id}`,
            })
            .pipe(Effect.orDie);
        }
        if (event.payload.action === "fanout-retry") {
          const comments = yield* issues
            .listComments({ index: event.payload.issue.number })
            .pipe(Effect.orDie);
          if (
            !comments.some(
              (comment) => comment.body === `retry approved ${event.id}`,
            )
          ) {
            return yield* Effect.die("subscriber awaiting retry approval");
          }
        }
      }),
  );
  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = yield* Effect.sync(
        () => new URL(request.url, "https://fixture.invalid"),
      );
      const index = Number(url.searchParams.get("index") ?? "1");
      const sha = url.searchParams.get("sha") ?? "";
      const route = url.pathname;
      if (route.startsWith("/__alchemy/forgejo/")) {
        yield* request.text.pipe(Effect.orDie);
        return yield* Effect.die(
          new Error("Application handler received a reserved webhook request"),
        );
      }
      if (route === "/health") return HttpServerResponse.text("ok");
      const value = yield* Effect.gen(function* () {
        switch (route) {
          case "/read":
            return yield* read.get();
          case "/other":
            return yield* otherRead.get();
          case "/topics":
            return yield* read.getTopics();
          case "/topics/write":
            return yield* write.setTopics({ topics: ["alchemy-runtime"] });
          case "/topics/read-write":
            yield* readWrite.setTopics({ topics: ["alchemy-read-write"] });
            return yield* readWrite.getTopics();
          case "/content":
            return yield* read.getContent({ filepath: "runtime.txt" });
          case "/file/create":
            return yield* write.createFile({
              filepath: "runtime.txt",
              content: "aGVsbG8=",
              message: "runtime create",
            });
          case "/file/update":
            return yield* write.updateFile({
              filepath: "runtime.txt",
              sha,
              content: "dXBkYXRlZA==",
              message: "runtime update",
            });
          case "/file/delete":
            return yield* write.deleteFile({
              filepath: "runtime.txt",
              sha,
              message: "runtime delete",
            });
          case "/issues":
            return yield* issues.list();
          case "/issues/get":
            return yield* issues.get({ index });
          case "/issues/comments":
            return yield* issues.listComments({ index });
          case "/issues/create":
            return yield* writeIssues.create({ title: "runtime issue" });
          case "/issues/update":
            return yield* writeIssues.update({
              index,
              title: "runtime updated",
            });
          case "/issues/comment":
            return yield* writeIssues.createComment({
              index,
              body: "runtime comment",
            });
          case "/issues/read-write":
            yield* readWriteIssues.update({ index, body: "combined client" });
            return yield* readWriteIssues.get({ index });
          default:
            return { unrelated: true };
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            error: error._tag,
          }),
        ),
      );
      return yield* HttpServerResponse.json(value);
    }),
  };
});
