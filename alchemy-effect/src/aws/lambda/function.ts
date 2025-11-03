import { Policy, Runtime, type Capability } from "alchemy-effect";
import type * as IAM from "../iam.ts";

export type { Context } from "aws-lambda";

export interface FunctionProps<Req = any> {
  functionName?: string;
  functionArn?: string;
  main: string;
  handler?: string;
  memory?: number;
  runtime?: "nodejs20x" | "nodejs22x";
  architecture?: "x86_64" | "arm64";
  url?: boolean;
  bindings: Policy<Function, Extract<Req, Capability>>;
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

export interface Function extends Runtime<"AWS.Lambda.Function"> {
  props: FunctionProps;
  attr: FunctionAttr<Extract<this["props"], FunctionProps>>;
  binding: {
    env: {
      [key: string]: string;
    };
    policyStatements: IAM.PolicyStatement[];
  };
}
export const Function = Runtime("AWS.Lambda.Function")<Function>();
