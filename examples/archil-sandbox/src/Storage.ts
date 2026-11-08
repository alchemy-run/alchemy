import * as Archil from "@alchemy.run/archil";
import * as Effect from "effect/Effect";

/** The disk every command runs against. */
export const Repo = Archil.Disk("Repo", {});

/** Built at deploy: the repository cloned onto Repo, then checkpointed. */
export const Base = Effect.gen(function* () {
  const repo = yield* Repo;
  return yield* Archil.Checkpoint("Base", {
    disk: repo.diskId,
    run: [
      "test -d is || git clone --depth 1 https://github.com/sindresorhus/is is",
      "test -d slugify || git clone --depth 1 https://github.com/sindresorhus/slugify slugify",
    ],
  });
});
