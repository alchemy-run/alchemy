import { Rejection } from "alchemy/Fold";

/** The account is not open. */
export class NotOpen extends Rejection.make("NotOpen") {}
