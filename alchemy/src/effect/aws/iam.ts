import * as Context from "effect/Context";
import { IAM as IAMClient } from "itty-aws/iam";
import { createAWSServiceClientLayer } from "./client.ts";

export class Client extends Context.Tag("AWS::IAM::Client")<
  Client,
  IAMClient
>() {}

export const client = createAWSServiceClientLayer(Client, IAMClient);

export interface PolicyDocument {
  Version: "2012-10-17";
  Statement: PolicyStatement[];
}

export interface PolicyStatement {
  Effect: "Allow" | "Deny";
  Sid?: string;
  Action: string[];
  Resource: string[];
  Condition?: Record<string, Record<string, string | string[]>>;
  Principal?: Record<string, string | string[]>;
  NotPrincipal?: Record<string, string | string[]>;
  NotAction?: string[];
  NotResource?: string[];
}
