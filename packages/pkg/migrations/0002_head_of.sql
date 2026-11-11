-- head_of names the branch whose latest publication this row belongs to,
-- for branches listed in the policy's keepLatest. The sweep never deletes
-- such a row. The branch's next publication clears head_of on the rows it
-- does not republish, which starts their normal TTL from that moment.
ALTER TABLE tags ADD COLUMN head_of TEXT;
CREATE INDEX tags_head_of ON tags (package, head_of);
