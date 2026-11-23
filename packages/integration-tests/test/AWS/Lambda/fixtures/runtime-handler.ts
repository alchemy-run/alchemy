import { readFileSync } from "node:fs";

// Reports the marker file a customer-managed runtime image writes, or `none`
// on a Lambda-managed runtime.
export default async () => {
  try {
    return { marker: readFileSync("/var/runtime/runtime-info.txt", "utf8") };
  } catch {
    return { marker: "none" };
  }
};
