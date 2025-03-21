import { alchemize } from "./alchemize";

const [script, ...args] = process.argv.slice(2);
const password = process.env.ALCHEMY_PASSPHRASE;

if (args.includes("--destroy")) {
  await alchemize({
    mode: "destroy",
    password,
  });
} else {
  const execStack = (await import(script)).default;

  if (typeof execStack !== "function") {
    throw new Error(`${script} must export a default function`);
  }

  await execStack();

  await alchemize({
    mode: "up",
    password,
  });
}
