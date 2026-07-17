import * as Cloudflare from "alchemy/Cloudflare";
import * as Github from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ReleaseVersion } from "./ReleaseVersion.ts";

// the repository whose releases we watch — the resource is how a
// repository is named (its declared identity resolves statically)
const alchemyRepo = Github.Repository("alchemy", {
  owner: "alchemy-run",
  name: "alchemy",
});

export default Cloudflare.Worker(
  "ReleaseService",
  { main: import.meta.url },
  Effect.gen(function* () {
    const versions = yield* ReleaseVersion;

    yield* Github.consumeRepositoryEvents(
      alchemyRepo,
      { events: ["push"] },
      (event) => {
        // the wire delivers TYPED events (Github.PushEvent)
        const title = event.headCommit?.message.split("\n")[0] ?? "";
        const isRelease =
          event.branch === "main" && title.startsWith("chore(release):");

        return isRelease
          ? versions.getByName(event.headCommit!.id).generateBlog({
              input: event,
            })
          : Effect.log(
              `Skipping commit "${event.headCommit?.message}" (hash: ${event.headCommit?.id})`,
            );
      },
    );

    return {
      fetch: Effect.gen(function* () {
        yield* versions.getByName("TEST").generateBlog({
          input: "TEST",
        });
        return HttpServerResponse.text("Hello, world!");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.GitHubRepositoryEventSourceLive)),
);
