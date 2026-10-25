// The fixture's "build": publish src/ as public/.
import { cpSync, rmSync } from "node:fs";

rmSync("public", { recursive: true, force: true });
cpSync("src", "public", { recursive: true });
