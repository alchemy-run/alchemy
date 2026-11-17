import * as Data from "effect/Data";

export class LambdaRolePolicyTooLarge extends Data.TaggedError("LambdaRolePolicyTooLarge")<{
  roleName: string;
  sizeBytes: number;
  limitBytes: number;
}> {
  override get message() {
    return `Lambda execution role ${this.roleName} requires ${this.sizeBytes} inline-policy bytes after compaction (including its log-group guard); limit is ${this.limitBytes}. Reduce binding permissions or use an explicitly designed managed-policy split.`;
  }
}
