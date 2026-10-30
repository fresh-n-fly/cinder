-- One row per unlock. The ticket itself is never stored, only its SHA-256.
-- Each grant carries its own fetch budget, so one recipient's unlock no
-- longer replaces another recipient's ticket.
create table if not exists batch_grants (
  token_hash text primary key,
  batch_id text not null,
  expires_at timestamptz not null,
  fetches integer not null default 0,
  fetch_limit integer not null,
  created_at timestamptz not null default now()
);
create index if not exists batch_grants_batch_id_idx on batch_grants (batch_id);
create index if not exists batch_grants_expires_at_idx on batch_grants (expires_at);

-- Wrong-password counts per seal and per client network (keyed hash).
create table if not exists unlock_attempts (
  batch_id text not null,
  client_key text not null,
  failures integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (batch_id, client_key)
);

-- Format 2 binds each file's position, the file count, and each file's chunk
-- count into the AES-GCM associated data.
alter table sealed_files add column if not exists file_index integer;
alter table sealed_files add column if not exists aad_version integer not null default 1;

-- Carry live tickets over as hashed grants so downloads in progress survive
-- the upgrade.
insert into batch_grants (token_hash, batch_id, expires_at, fetch_limit)
select encode(sha256(convert_to(b.grant_token, 'UTF8')), 'hex'),
       b.id,
       b.grant_expires_at,
       (2 * greatest(1, coalesce((
         select sum(greatest(coalesce(f.chunk_count, 0),
                             ceil(coalesce(f.cipher_bytes, octet_length(f.ciphertext) * 3 / 4, 0)::numeric / 2097152)::int,
                             1))
         from sealed_files f where f.batch_id = b.id), 1)) + 8)::int
from sealed_batches b
where b.grant_token ~ '^[0-9a-f]{32}$' and b.grant_expires_at > now()
on conflict do nothing;

update sealed_batches
set grant_token = null, grant_expires_at = null
where grant_token is not null or grant_expires_at is not null;

-- The lifetime wrong-password budget grows from 12 to 30. Seals that were
-- already locked under the old rule stay locked.
update sealed_batches set failed_attempts = 30 where failed_attempts >= 12;
update sealed_files set failed_attempts = 30 where failed_attempts >= 12 and batch_id is null;

-- Earlier versions stored an unkeyed SHA-256 of the client address, which can
-- be reversed by hashing every IPv4 address. Drop those; new rows use a keyed
-- hash of the address (or its IPv6 /64).
update sealed_batches set client_key = null where client_key is not null;
update upload_sessions set client_ip = null where client_ip is not null;
