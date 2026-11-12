/**
 * A person to ask about a catalog, schema, table or data product. Galaxy
 * needs both the ID and the email of the user.
 */
export interface Contact {
  /** The user's ID (see `StarburstGalaxy.User.User`). */
  readonly userId: string;
  /** The user's email. */
  readonly email: string;
}

/** A link shown on a schema or data product. */
export interface Link {
  /** Link text. */
  readonly name: string;
  /** Link target. */
  readonly uri: string;
}

/** Contacts as Galaxy's requests take them. */
export const contactsOf = (contacts: ReadonlyArray<Contact> | undefined) =>
  (contacts ?? []).map(({ userId, email }) => ({ userId, email }));

/** Links as Galaxy's requests take them. */
export const linksOf = (links: ReadonlyArray<Link> | undefined) =>
  (links ?? []).map(({ name, uri }) => ({ name, uri }));
