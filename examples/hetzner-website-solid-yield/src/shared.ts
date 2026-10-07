import * as Hetzner from "alchemy/Hetzner";

export const API_PORT = 3001;

/**
 * One cpx12 both the API unit and the Website static server share.
 * Matches `Hetzner.Website` auto-create (`cpx12` / `ubuntu-24.04` / `fsn1`).
 */
export const Box = Hetzner.Server("Box", {
  serverType: "cpx12",
  image: "ubuntu-24.04",
  location: "fsn1",
});
