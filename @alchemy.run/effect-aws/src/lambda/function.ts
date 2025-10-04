import type {
  LambdaFunctionURLEvent,
  LambdaFunctionURLResult,
} from "aws-lambda";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import {
  Service,
  type BindingLifecycle,
  type Resource,
  type Statement,
} from "@alchemy.run/effect";
import type { Context as LambdaContext } from "aws-lambda";
import type * as IAM from "../iam.ts";
import { FunctionProvider } from "./function.provider.ts";

export type FunctionType = typeof FunctionType;
export const FunctionType = "AWS::Lambda::Function";

export type FunctionProps = {
  url?: boolean;
  functionName?: string;
};

export type FunctionAttributes<ID extends string, _P extends FunctionProps> = {
  type: FunctionType;
  id: ID;
  functionName: string;
  functionArn: string;
  functionUrl: string | undefined;
  roleName: string;
  roleArn: string;
  code: {
    hash: string;
  };
};

export type Function<
  ID extends string = string,
  P extends FunctionProps = FunctionProps,
> = Resource<
  FunctionType,
  ID,
  P,
  FunctionAttributes<ID, P>,
  typeof FunctionProvider
>;

export type FunctionHandler = (
  event: any,
  ctx: any,
) => Effect.Effect<any, any, any>;

export const Function = <ID extends string, P extends FunctionProps>(
  id: ID,
  props: P = {} as P,
) =>
  Object.assign(
    Context.Tag(id)() as Context.TagClass<P, ID, FunctionAttributes<ID, P>>,
    {
      kind: "Resource",
      type: FunctionType,
      id,
      props,
      provider: FunctionProvider,
      // phantom
      attributes: undefined! as FunctionAttributes<ID, P>,
      serve<Self, Err, Req>(
        this: Self,
        handler: (
          event: LambdaFunctionURLEvent,
          context: LambdaContext,
        ) => Effect.Effect<LambdaFunctionURLResult, Err, Req>,
      ) {
        return Service(id, handler);
      },
    } as const,
  );

export type FunctionBinding<Stmt extends Statement = Statement> =
  BindingLifecycle<
    {
      functionArn: string;
      functionName: string;
      env: Record<string, string>;
      policyStatements: IAM.PolicyStatement[];
    },
    Stmt
  >;
