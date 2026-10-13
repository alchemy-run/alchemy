import * as AWS from "alchemy/AWS";
import * as Hetzner from "alchemy/Hetzner";
import * as Neon from "alchemy/Neon";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";

/** What each host needs to run on, shared by the host roll's snippets. */
export const Cluster = AWS.ECS.Cluster("Cluster", {});
export const Box = Hetzner.Server("Box", {
  serverType: "cpx12",
  image: "ubuntu-24.04",
  location: "nbg1",
});
export const Chat = Railway.Project("Chat", {});
export const Main = Effect.gen(function* () {
  return yield* Neon.Branch("Main", { project: yield* Neon.Project("Db") });
});
