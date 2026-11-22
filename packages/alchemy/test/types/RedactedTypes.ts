import * as Redacted from "effect/Redacted";
import * as Output from "@/Output.ts";
import type { Resource } from "@/Resource.ts";

// `evaluate` returns a Redacted by identity, as a leaf, so its Output must
// stay opaque. Before `Redacted` joined the leaf checks in `ToOutput` and
// `AttrOutput`, it matched the object branch and exploded into an
// ObjectExpr mapped over its own members (`pipe`, `label`,
// `~effect/Redacted`, …), which also printed in full in every declaration
// that carried one.

type NotExploded<T> = "label" extends keyof T ? false : true;

// --- ToOutput keeps a Redacted as a plain Output ---
declare const t1: NotExploded<Output.ToOutput<Redacted.Redacted<string>, never>>;
const _t1: true = t1;

// --- a Redacted built through Output.map stays opaque ---
declare const key: Output.Output<string, never>;
const mapped = Output.map(key, (value) => Redacted.make(value));
declare const t2: NotExploded<typeof mapped>;
const _t2: true = t2;
const _o1: Output.Output<Redacted.Redacted<string>, never> = mapped;

// --- a Redacted resource attribute stays opaque ---
declare const database: Resource<
  "Test.Database",
  undefined,
  { password: Redacted.Redacted<string> }
>;
const password = database.password;
declare const t3: NotExploded<typeof password>;
const _t3: true = t3;
const _o2: Output.Output<Redacted.Redacted<string>, never> = password;

// --- objects still upgrade to ObjectExpr, and their Redacted props stay opaque ---
declare const connection: Output.ToOutput<
  { host: string; password: Redacted.Redacted<string> },
  never
>;
const connectionPassword = connection.password;
declare const t4: NotExploded<typeof connectionPassword>;
const _t4: true = t4;
