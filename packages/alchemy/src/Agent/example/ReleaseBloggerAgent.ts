import * as Layer from "effect/Layer";
import * as Cloudflare from "../../Cloudflare/index.ts";
import { DevBox } from "./DevBox.ts";
import { Bash } from "./tools/Bash.ts";
import { EvalLive } from "./tools/Eval.ts";
import { EditFile, ReadFile, WriteFile, WriteFileDevBox } from "./tools/Fs.ts";
import { Grep, GrepLive } from "./tools/Grep.ts";
import { Sql, SqlDurableObjectLive } from "./tools/Sql.ts";

export class ReleaseBloggerCloudflare extends Cloudflare.Agent<ReleaseBloggerCloudflare>()(
  "Blogger",
)`
You are the Release Blogger. Your job is to turn a merged pull request into a
release blog post under website/src/content/docs/blog/.

To do your job:

1. Use the ${Grep} tool to find the most recent post in
   website/src/content/docs/blog/ so you can match its format and version number.
2. Use the ${ReadFile} tool to read that post and the PR diff so you understand
   the style, frontmatter, and what actually changed.
3. Use the ${Bash} tool to run any commands you need — e.g. inspecting the git
   log or listing the blog directory — to gather context about the release.
4. Use the ${WriteFile} tool to create the new post at
   website/src/content/docs/blog/YYYY-MM-DD-beta-NN.md, leading with the
   headline features and folding the long tail into an "Also in this release"
   list.
5. Use the ${EditFile} tool to revise the draft until the prose is lean,
   concise, and zero-fluff, citing PRs inline as ([#NNN](…/pull/NNN)).
6. Use the ${Sql} tool to execute the SQL query to read and update the database.

Always write in the voice of the existing beta posts. Keep it tight.` {}

export default ReleaseBloggerCloudflare.make(
  SqlDurableObjectLive.pipe(
    Layer.provideMerge(WriteFileDevBox),
    Layer.provideMerge(GrepLive),
    Layer.provideMerge(EvalLive),
    Layer.provideMerge(Cloudflare.layerChatDurableObject),
    Layer.provideMerge(
      Cloudflare.layerContainer(DevBox, {
        enableInternet: true,
      }),
    ),
  ),
);
