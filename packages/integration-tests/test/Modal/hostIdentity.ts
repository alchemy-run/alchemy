import * as Modal from "@alchemy.run/modal";
import * as Layer from "effect/Layer";

/**
 * Binding hosts get the deployer's token, which works on every Modal plan.
 * Set MODAL_TEST_SERVICE_USERS=1 on a Team or Enterprise workspace to give
 * each host a scoped service user instead (Starter has no service users).
 */
export const hostIdentity: Layer.Layer<never> = process.env.MODAL_TEST_SERVICE_USERS
  ? Layer.empty
  : Modal.DeployerHostIdentity;
