import * as Neon from "@/Neon";
import * as Prisma from "@/Prisma";
import * as PrismaPostgres from "@/Prisma/ORM/Postgres.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { fileURLToPath } from "node:url";
import type { Contract } from "./fixtures/client/generated/contract.d.ts";
import contractJson from "./fixtures/client/generated/contract.json";

const { test } = Test.make({
  providers: Layer.mergeAll(Prisma.providers(), Neon.providers()),
});

const HOOK_TIMEOUT = 300_000;

const fixtureConfig = Effect.gen(function* () {
  const path = yield* Path.Path;
  const self = yield* path.fromFileUrl(new URL(import.meta.url));
  return path.join(
    path.dirname(self),
    "fixtures",
    "client",
    "prisma-next.config.ts",
  );
});

/** Deploy the fixture contract onto a fresh Neon branch and hand back a db. */
const deployDatabase = (stack: {
  deploy: <A, E, R>(e: Effect.Effect<A, E, R>) => any;
}) =>
  Effect.gen(function* () {
    const configPath = yield* fixtureConfig;
    const { branch } = yield* stack.deploy(
      Effect.gen(function* () {
        const contract = yield* Prisma.Contract("client-contract", {
          config: configPath,
        });
        const project = yield* Neon.Project("PrismaClientProject");
        const branch = yield* Neon.Branch("PrismaClientBranch", { project });
        yield* Prisma.Migrate("client-migrate", {
          url: branch.connectionUri,
          contract,
        });
        return { branch };
      }),
    );
    return yield* PrismaPostgres.Postgres<Contract>()(
      Effect.succeed(Redacted.make(branch.connectionUri as string)),
      { contractJson },
    );
  });

test.provider(
  "orm lane: typed CRUD, include, select, and where gating",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const db = yield* deployDatabase(stack);

      yield* Effect.scoped(
        Effect.gen(function* () {
          // create — input + row are contract-typed
          const alice = yield* db.orm.public.User.create({
            email: "alice@example.com",
            name: "Alice",
          });
          expect(alice.id).toBeGreaterThan(0);
          expect(alice.name).toEqual("Alice");

          yield* db.orm.public.Post.create({
            title: "hello",
            authorId: alice.id,
          });

          // include — Row gains a typed relation field
          const withPosts = yield* db.orm.public.User.where({ id: alice.id })
            .include("posts")
            .first();
          expect(withPosts?.posts).toHaveLength(1);
          expect(withPosts?.posts[0]?.title).toEqual("hello");

          // where callback form
          const byEmail = yield* db.orm.public.User.where((u) =>
            u.email.eq("alice@example.com"),
          ).first();
          expect(byEmail?.id).toEqual(alice.id);

          // select — Row narrows to the projection
          const projected = yield* db.orm.public.User.select(
            "id",
            "email",
          ).all();
          expect(projected[0]?.email).toEqual("alice@example.com");
          // @ts-expect-error `name` was not selected — narrowing is real
          projected[0]?.name;

          // update requires a prior where (compile-time gate) and works
          const renamed = yield* db.orm.public.User.where({
            id: alice.id,
          }).update({ name: "Alice II" });
          expect(renamed?.name).toEqual("Alice II");

          // @ts-expect-error update without where() is a type error
          db.orm.public.User.update({ name: "nope" });

          // laziness: one effect, two evaluations → two rows
          const insert = db.orm.public.Post.create({
            title: "repeat",
            authorId: alice.id,
          });
          yield* insert;
          yield* insert;
          const repeats = yield* db.orm.public.Post.where({
            title: "repeat",
          }).all();
          expect(repeats).toHaveLength(2);

          // granular constraint tags: unique violation is its own error
          const dup = yield* db.orm.public.User.create({
            email: "alice@example.com",
          }).pipe(
            Effect.as("created" as const),
            Effect.catchTag("Prisma.UniqueViolationError", (error) =>
              Effect.succeed(
                error.sqlState === "23505"
                  ? ("unique" as const)
                  : ("other" as const),
              ),
            ),
          );
          expect(dup).toEqual("unique");

          // ...and so is a foreign-key violation
          const fk = yield* db.orm.public.Post.create({
            title: "orphan",
            authorId: 999_999,
          }).pipe(
            Effect.as("created" as const),
            Effect.catchTag("Prisma.ForeignKeyViolationError", () =>
              Effect.succeed("fk-violation" as const),
            ),
          );
          expect(fk).toEqual("fk-violation");

          // ORM misuse surfaces as the ORM category tag with a typed code.
          // (`count()` is refinement-only; even prisma's own types reject
          // this call, so the cast is deliberate — the test pins the
          // *runtime* classification of the thrown ORM.* error.)
          const misuse = yield* db
            .use(
              (c) =>
                c.orm.public.User.count() as unknown as PromiseLike<unknown>,
            )
            .pipe(
              Effect.as("ok" as const),
              Effect.catchTag("Prisma.OrmError", (error) =>
                Effect.succeed(error.code),
              ),
            );
          expect(misuse).toEqual("ORM.INCLUDE_INVALID");

          // delete gating + row-returning delete
          const deleted = yield* db.orm.public.User.where({
            email: "nobody@example.com",
          }).delete();
          expect(deleted).toBeNull();
        }),
      );

      yield* stack.destroy();
    }),
  { timeout: HOOK_TIMEOUT },
);

test.provider(
  "sql lane, streaming, and transactions",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const db = yield* deployDatabase(stack);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const bob = yield* db.orm.public.User.create({
            email: "bob@example.com",
            name: "Bob",
          });

          // sql builder lane: pure plan, Effect executor, typed rows
          const plan = db.sql.public.user.select("id", "email").build();
          const rows = yield* db.execute(plan);
          expect(rows.map((r) => r.email)).toContain("bob@example.com");

          // stream lane (fresh execution per run)
          const streamed = yield* Stream.runCollect(db.stream(plan));
          expect([...streamed].length).toBe(rows.length);

          // transaction: commit path
          const committed = yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const post = yield* tx.orm.public.Post.create({
                title: "tx-post",
                authorId: bob.id,
              });
              const read = yield* tx.orm.public.Post.where({
                id: post.id,
              }).first();
              return read?.title;
            }),
          );
          expect(committed).toEqual("tx-post");
          const persisted = yield* db.orm.public.Post.where({
            title: "tx-post",
          }).all();
          expect(persisted).toHaveLength(1);

          // transaction: explicit rollback is a typed failure and undoes writes
          const rolledBack = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.orm.public.Post.create({
                  title: "rollback-post",
                  authorId: bob.id,
                });
                return yield* tx.rollback();
              }),
            )
            .pipe(
              Effect.as("committed" as const),
              Effect.catchTag("Prisma.RollbackError", () =>
                Effect.succeed("rolled-back" as const),
              ),
            );
          expect(rolledBack).toEqual("rolled-back");
          expect(
            yield* db.orm.public.Post.where({ title: "rollback-post" }).all(),
          ).toHaveLength(0);

          // transaction: a failing effect rolls back too
          const failed = yield* Effect.result(
            db.transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.orm.public.Post.create({
                  title: "failed-post",
                  authorId: bob.id,
                });
                // unique violation aborts the transaction
                yield* tx.orm.public.User.create({
                  email: "bob@example.com",
                });
              }),
            ),
          );
          expect(Result.isFailure(failed)).toBe(true);
          expect(
            yield* db.orm.public.Post.where({ title: "failed-post" }).all(),
          ).toHaveLength(0);
        }),
      );

      yield* stack.destroy();
    }),
  { timeout: HOOK_TIMEOUT },
);
