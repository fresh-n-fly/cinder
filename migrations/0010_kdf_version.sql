-- Key derivation version per seal.
--   1: PBKDF2-SHA-256 with separate key and proof salts (seals made before
--      this upgrade, and legacy single-file seals).
--   2: Argon2id with one salt, then HKDF into separate key and proof outputs.
-- The page reads this before unlocking, and refuses version 1 once every
-- version-1 seal has expired.
alter table sealed_batches add column if not exists kdf integer not null default 1;
