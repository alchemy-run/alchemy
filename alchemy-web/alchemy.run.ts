import alchemy from "alchemy";
import { Folder } from "alchemy/fs";
import { Document } from "alchemy/docs";
import path from "path";

await using _ = alchemy("alchemy.run", {
  stage: "prod",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  password: process.env.SECRET_PASSPHRASE,
  quiet: !process.argv.includes("--verbose"),
});

const docs = await Folder(path.join("alchemy.run", "docs"));

await Document("home.md", {
  path: path.join(docs.path, "home.md"),
  prompt: await alchemy`Generate a landing page.`,
});
