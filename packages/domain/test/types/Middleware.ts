/**
 * Type-level regressions for middleware lists, which run in declaration order
 * (#3413): what an entry provides satisfies what a later entry requires.
 */
import * as Domain from "@alchemy.run/domain";
import * as Context from "effect/Context";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(_: T) => {};

class Principal extends Context.Service<Principal, string>()("Test/Principal") {}

class Unauthenticated extends Domain.Rejection("Unauthenticated") {}
class Banned extends Domain.Rejection("Banned") {}

/** Authenticates the caller and provides who they are. */
class Session extends RpcMiddleware.Service<Session, { provides: Principal }>()("Test/Session", {
  error: Unauthenticated,
}) {}
/** Refuses banned callers: it reads the Principal an earlier entry provides. */
class BanCheck extends RpcMiddleware.Service<BanCheck, { requires: Principal }>()("Test/BanCheck", {
  error: Banned,
}) {}

class Posted extends Domain.Event("Posted", { text: Schema.String }) {}

class Post extends Domain.Command("Post", {
  middleware: [Session, BanCheck],
  input: { id: Schema.String, text: Schema.String },
  events: [Posted],
}) {}

// Session runs first and provides the Principal BanCheck requires, so the
// command's RPC requires nothing more.
assertType<Equals<Rpc.ExtractRequires<typeof Post.rpc, "Post">, never>>(true);
assertType<Equals<Rpc.ExtractProvides<typeof Post.rpc, "Post">, Principal>>(true);

class PostUnchecked extends Domain.Command("PostUnchecked", {
  middleware: [BanCheck, Session],
  input: { id: Schema.String, text: Schema.String },
  events: [Posted],
}) {}

// Listed first, BanCheck runs before Session provides anything: what it
// requires is still required.
assertType<Equals<Rpc.ExtractRequires<typeof PostUnchecked.rpc, "PostUnchecked">, Principal>>(true);
