export interface PolicyDocument {
  Version: "2012-10-17";
  Statement: PolicyStatement[];
}

export interface PolicyStatement {
  Effect: "Allow" | "Deny";
  Sid?: string;
  Action: string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
  Principal?: Record<string, string | string[]>;
  NotPrincipal?: Record<string, string | string[]>;
  NotAction?: string[];
  NotResource?: string[];
}
