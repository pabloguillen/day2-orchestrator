-- Only the author can delete a comment (before: the moment's owner could too).
-- Unwanted comments on your moment are reported, not deleted.
alter policy comments_delete on dotty.comments using (user_id = (select auth.uid()));
