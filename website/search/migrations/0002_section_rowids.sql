-- Sections are now written with a rowid derived from their id (see
-- `sectionRowid`), so lookups and deletes go by primary key. Clear rows
-- written before that; the next IndexDocs run rewrites every section.
DELETE FROM sections;
