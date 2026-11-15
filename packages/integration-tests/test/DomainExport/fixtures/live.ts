/**
 * The live tier: the store and engine suites against a database an Alchemy
 * provider deploys for the file (PlanetScale, Neon, Turso), destroyed when
 * the file ends. Two switches, both required: the provider's own variable
 * (`PLANETSCALE_TEST`, `NEON_TEST`, `TURSO_TEST`), as its suites use, and
 * the run naming `export-live`. A run that names neither spends nothing.
 */
import * as Export from "@alchemy.run/domain/Export";
import { describe } from "@alchemy.run/test";
import * as CoreModule from "@alchemy.run/test/Core";
import type * as Core from "@alchemy.run/test/Core";
import type { Input } from "alchemy/Input";
import type { StackServices } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlClient } from "effect/sql/SqlClient";
import { storeConformance } from "../../Domain/export-conformance/conformance.ts";
import { EngineLake, engineConformance } from "../../Domain/export-conformance/engines.ts";
import {
  deployedWith,
  dockerShrinks,
  exportSuite,
  runsOr,
  testTimeout,
  waitFor,
} from "./docker.ts";

/** The live tier's opt-in tag: its tests run only when a run names it. */
export const liveTag = "export-live";

export interface LiveSqlSuiteOptions<ROut, Outputs> {
  /** The test file (`import.meta.url`), which owns the stack. */
  readonly file: string;
  /** The database, for the suite's name: `PlanetScale MySQL`. */
  readonly label: string;
  /** The provider's own switch; unset, the file declares nothing. */
  readonly gate: string;
  /** The provider's tags, as its own suites carry them. */
  readonly providerTags: ReadonlyArray<string>;
  readonly options: Core.MakeOptions<ROut>;
  /** The resources: a database and a credential for it. */
  readonly deploy: Effect.Effect<Outputs, unknown, ROut | StackServices>;
  /** A client for the deployed database. */
  readonly client: (outputs: Input.Resolve<Outputs>) => Layer.Layer<SqlClient, unknown>;
  readonly dialect: "postgres" | "mysql" | "sqlite";
}

export const liveSqlSuite = <ROut, Outputs>({
  file,
  label,
  gate,
  providerTags,
  options,
  deploy,
  client,
  dialect,
}: LiveSqlSuiteOptions<ROut, Outputs>) => {
  const environment = Layer.unwrap(
    Effect.gen(function* () {
      const outputs = yield* deployedWith(
        options,
        CoreModule.scratchStack(options, label.replaceAll(" ", ""), file),
        deploy,
      );
      const connected = client(outputs);
      // A new database can refuse connections while its endpoint comes up.
      yield* waitFor(
        label,
        Effect.flatMap(SqlClient, (sql) => sql`SELECT 1`).pipe(
          Effect.provide(connected),
          Effect.timeout("20 seconds"),
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      );
      return Layer.orDie(connected);
    }),
  );
  const tags = { tags: [...providerTags, "live"], optInTags: [liveTag] };
  // Unset, the provider's switch skips the suite: it is reported as skipped, not as no tests.
  describe.skipIf(!process.env[gate])(`Domain Export, live (${label})`, () =>
    // The database is provisioned (a PlanetScale one takes minutes) before any test runs.
    exportSuite(environment, `SQL store and engine on ${label}`, (it) => {
      const test = (name: string, effect: Effect.Effect<void, unknown, SqlClient>) =>
        it.effect(name, () => effect, { timeout: testTimeout, ...tags });
      // Fewer sequences than in Docker: each statement crosses the internet.
      storeConformance({
        test,
        make: Export.Sql.store({ name: label }),
        kind: "live",
        runs: runsOr(3),
        maxShrinks: dockerShrinks,
      });
      engineConformance<SqlClient>({
        test,
        dialect,
        layer: (analytics, name) =>
          analytics
            .toLayer(Export.Sql.engine({ name }))
            .pipe(Layer.provideMerge(EngineLake.toLayer(Export.Sql.store()))),
        freshNames: true,
        kind: "live",
        runs: runsOr(2),
        maxShrinks: dockerShrinks,
      });
    }),
  );
};
