-- Connect your stores: the OAuth state is single-use (the first callback
-- marks it), and the sealed secret now also holds the PKCE verifier, so it's
-- set when the sign-in starts.
ALTER TABLE connect_google_sessions ADD COLUMN state_used_at timestamptz;
DELETE FROM connect_google_sessions WHERE secret IS NULL;
ALTER TABLE connect_google_sessions ALTER COLUMN secret SET NOT NULL;
