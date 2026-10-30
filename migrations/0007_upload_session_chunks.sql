alter table upload_sessions add column if not exists had_chunks boolean not null default false;

update upload_sessions s
set had_chunks = true
where s.client_ip is not null
   or exists (select 1 from upload_chunks c where c.upload_id = s.id);

-- Older deployments stored raw client IPs. New writes store a one-way key.
-- Clear existing live values and force one cleanup rewrite for those rows.
update upload_sessions set client_ip = null where client_ip is not null;
