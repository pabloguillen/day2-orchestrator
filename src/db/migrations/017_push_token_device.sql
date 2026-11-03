-- Push tokens are bound to the library's device id that registered them
-- (src/messages/tokens.ts): only that device can replace or clear its token,
-- and an opt-out (token null) only affects the sending device's entry.
-- NULL for tokens registered before this.
ALTER TABLE push_tokens ADD COLUMN device text;
CREATE INDEX push_tokens_app_user_device ON push_tokens (app_id, user_id, device);
