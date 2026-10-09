-- One row per docs section (a page's intro, or an h2/h3 and its body).
-- Written by the IndexDocs Action; queried by src/search-api.ts.
CREATE VIRTUAL TABLE sections USING fts5(
  id UNINDEXED,
  hash UNINDEXED,
  path UNINDEXED,
  anchor UNINDEXED,
  provider UNINDEXED,
  section UNINDEXED,
  title,
  heading,
  body,
  tokenize = 'porter unicode61'
);
