alter table sealed_files add column if not exists cipher_bytes integer not null default 0;
