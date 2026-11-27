import * as Prove from "@alchemy.run/domain/Prove";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { cases, sources } from "./conformance/modules.ts";

// A file and the files it reads. `conformance/modules.ts` is the table: each
// case is a name that reaches the aggregate one way, by an import, an export
// or a line at the top of a file. Each is read by the prover and run by the
// real code on the same inputs, and has to give the same.

it.effect(
  "every way a name is imported, exported and declared in a file is what the real code gives",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const here = yield* path.fromFileUrl(new URL("./conformance/", import.meta.url));
      const directory = path.join(here, "modules.generated");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* Effect.addFinalizer(() =>
        process.env.KEEP_GENERATED
          ? Effect.void
          : Effect.ignore(fs.remove(directory, { recursive: true })),
      );
      for (const [name, text] of Object.entries(sources()))
        yield* fs.writeFileString(path.join(directory, name), text);
      const url = yield* path.toFileUrl(path.join(directory, "Bench.aggregate.ts"));
      const fixture: { readonly Bench: Parameters<typeof Prove.report>[0] } = yield* Effect.promise(
        () => import(/* @vite-ignore */ url.href),
      );
      const report = yield* Prove.report(fixture.Bench, { source: url });
      const verdicts = new Map(report.commands.map((command) => [command.command, command.schema]));
      const reasonOf = (name: string) => {
        const verdict = verdicts.get(name);
        return verdict && "reason" in verdict ? verdict.reason : "";
      };
      // A name the prover reads is proved, and one it does not is reported with the reason given.
      const wrong = cases.flatMap(({ name, unread }) => {
        const tag = verdicts.get(name)?._tag;
        const fine = unread
          ? tag === "NotTranslated" && unread.test(reasonOf(name))
          : tag === "Proved";
        return fine ? [] : [`${name}: ${tag} ${reasonOf(name)}`];
      });
      expect(wrong).toEqual([]);
      expect(report.agreement.differs).toEqual([]);
      expect(report.agreement.uncompared).toBe(0);
      expect(report.agreement.compared).toBeGreaterThanOrEqual(
        cases.filter((each) => !each.unread).length,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  120_000,
);
