import { createCli } from "trpc-cli";
import { auth } from "./commands/auth.ts";
import { create } from "./commands/create.ts";
import { deploy } from "./commands/deploy.ts";
import { destroy } from "./commands/destroy.ts";
import { dev } from "./commands/dev.ts";
import { init } from "./commands/init.ts";
import { run } from "./commands/run.ts";
import { getPackageVersion } from "./services/get-package-version.ts";
import { t } from "./trpc.ts";

const router = t.router({
  auth,
  create,
  init,
  deploy,
  destroy,
  dev,
  run,
});

export type AppRouter = typeof router;

const cli = createCli({
  router,
  name: "alchemy",
  version: getPackageVersion(),
  description:
    "🧪 Welcome to Alchemy! Creating infrastructure as code with JavaScript and TypeScript.",
});

cli.run({
  argv: rewriteLoginArgs(process.argv.slice(2)),
});

// TODO: is there a better way to alias "alchemy login" to "alchemy auth login"?
function rewriteLoginArgs(args: string[]) {
  const auth = args.indexOf("auth");
  const login = args.indexOf("login");
  if (auth === -1 && login !== -1) {
    const newArgs = [
      ...args.slice(0, login),
      "auth",
      "login",
      ...args.slice(login + 1),
    ];
    process.env.ALCHEMY_WARN_AUTH_LOGIN = "1";
    return newArgs;
  }
  return args;
}
