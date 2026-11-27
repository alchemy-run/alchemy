import * as Context from "effect/Context";
import type {
  Codec,
  FunctionDeclaration,
  FunctionKind,
  FunctionSpec,
  Handler,
} from "../Function.ts";

/** The factory behind `Convex.Query`, `Convex.Mutation` and `Convex.Action`. */
export const declare =
  <Kind extends FunctionKind>(kind: Kind) =>
  <Self>() =>
  <
    const Path extends string,
    Args extends Codec,
    Returns extends Codec | undefined = undefined,
    Error extends Codec | undefined = undefined,
    const Internal extends boolean = false,
  >(
    path: Path,
    spec: FunctionSpec<Args, Returns, Error, Internal>,
  ) =>
    Object.assign(
      Context.Service<Self, Handler<Kind, Args, Returns, Error>>()(`Convex.Function/${path}`),
      {
        kind,
        path,
        args: spec.args,
        returns: spec.returns as Returns,
        error: spec.error as Error,
        internal: (spec.internal ?? false) as Internal,
      } satisfies FunctionDeclaration<Kind, Path, Args, Returns, Error, Internal>,
    );
