import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { KeysDatabase } from "./KeysDatabase.ts";

/** The Vault's keys in D1: one row per subject. */
export const D1VaultKeys = Layer.effect(
  Domain.VaultKeys,
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(yield* KeysDatabase);
    const failed = (subject: string) => (cause: { readonly message: string }) =>
      new Domain.VaultError({ subject, reason: cause.message });
    const get = (subject: string) =>
      db
        .prepare("SELECT key FROM vault_keys WHERE subject = ?")
        .bind(subject)
        .first<{ readonly key: string }>()
        .pipe(
          Effect.map((row) => Option.fromNullishOr(row?.key)),
          Effect.mapError(failed(subject)),
        );
    return {
      get,
      // Two callers may make a key for the same subject at once: the first row wins, and both read it.
      create: (subject, key) =>
        db
          .prepare(
            "INSERT INTO vault_keys (subject, key) VALUES (?, ?) ON CONFLICT (subject) DO NOTHING",
          )
          .bind(subject, key)
          .run()
          .pipe(
            Effect.mapError(failed(subject)),
            Effect.andThen(get(subject)),
            Effect.map(Option.getOrElse(() => key)),
          ),
      delete: (subject) =>
        db
          .prepare("DELETE FROM vault_keys WHERE subject = ?")
          .bind(subject)
          .run()
          .pipe(Effect.asVoid, Effect.mapError(failed(subject))),
    };
  }),
);
