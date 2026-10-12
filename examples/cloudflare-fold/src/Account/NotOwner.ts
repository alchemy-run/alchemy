import { Rejection } from "alchemy/Fold";

/** The actor does not own the account. */
export class NotOwner extends Rejection.make("NotOwner") {}
