import * as AI from "alchemy/AI";
import { lineage } from "../Root.ts";
import { ProductManager } from "./Manager.ts";

/**
 * The PRODUCT GROUP — where the humans drive WHAT the company builds.
 * One member for now: the {@link ProductManager} heads it, and its
 * session is the `#product` channel. Growth (a researcher, a
 * designer) is a charter file + a splice here — a pull request, like
 * every structural change.
 */
export default class Product extends AI.Group<Product>(import.meta)(
  "Product",
) {}

export const ProductChart = Product.make`
  The product group of the company. ${ProductManager} heads it (its
  session is this group's channel): the humans open product
  conversations there, and it allocates them — a dedicated task or a
  fold into an existing one — through asks to the group that owns the
  work.
`;

/** The channel's address — the head's session at its lineage key.
 *  `key` is a GETTER: this module sits in the Root ↔ Group import
 *  cycle, and dereferencing `lineage` at module evaluation trips the
 *  TDZ at boot. */
export const PRODUCT_ADDRESS = {
  term: ProductManager["~alchemy/Name"],
  get key() {
    return lineage(AI.memberSlug(ProductManager["~alchemy/Name"]));
  },
};
