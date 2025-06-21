import { log } from "@clack/prompts";
import pc from "picocolors";

export function throwWithContext(error: unknown, context: string): never {
  const errorMsg = error instanceof Error ? error.message : String(error);
  log.error(pc.red(`❌ ${context}`));
  log.error(pc.gray(`   ${errorMsg}`));
  throw new Error(`${context}: ${errorMsg}`, {
    cause: error instanceof Error ? error : new Error(String(error)),
  });
}
