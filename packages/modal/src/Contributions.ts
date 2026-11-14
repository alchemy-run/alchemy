import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "modal",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.ModalAuth,
  ),
});
