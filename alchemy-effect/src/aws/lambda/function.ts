import { Runtime, type Capability, type RuntimeProps } from "alchemy-effect";
import type * as IAM from "../iam.ts";

export type { Context } from "aws-lambda";

export interface FunctionProps<Req = any> extends RuntimeProps<Function, Req> {
  functionName?: string;
  functionArn?: string;
  main: string;
  handler?: string;
  memory?: number;
  runtime?: "nodejs20.x" | "nodejs22.x";
  architecture?: "x86_64" | "arm64";
  url?: boolean;
}
export declare namespace FunctionProps {
  export type Simplified<Req> = FunctionProps<
    Capability.Simplify<Extract<Req, Capability>>
  >;
}

export type FunctionAttr<Props extends FunctionProps = FunctionProps> = {
  functionArn: string;
  functionName: string;
  functionUrl: Props["url"] extends true ? string : undefined;
  roleName: string;
  roleArn: string;
  code: {
    hash: string;
  };
};

export interface FunctionBinding {
  env?: {
    [key: string]: string;
  };
  policyStatements?: IAM.PolicyStatement[];
}

export interface Function extends Runtime<"AWS.Lambda.Function"> {
  props: FunctionProps;
  attr: FunctionAttr<Extract<this["props"], FunctionProps>>;
  binding: FunctionBinding;
}
export const Function = Runtime("AWS.Lambda.Function")<Function>();
