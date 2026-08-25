-- OpenShip 1.0 immutable Sources snapshots and Systems references.

create table source_snapshots (
  digest             text primary key,
  manifest           jsonb not null,
  bundle_extensions  jsonb not null default '{}',
  total_files        integer not null,
  total_bytes        bigint not null,
  created_at         timestamptz not null default now(),
  check (digest ~ '^sha256:[0-9a-f]{64}$'),
  check (total_files >= 0),
  check (total_bytes >= 0)
);

create table source_files (
  snapshot_digest text not null references source_snapshots(digest) on delete cascade,
  path            text not null,
  size            bigint not null,
  sha256          text not null,
  encoding        text not null check (encoding in ('utf-8', 'base64')),
  media_type      text not null,
  file_type       text not null check (file_type in ('file', 'symlink')),
  target          text,
  content         bytea not null,
  extensions      jsonb not null default '{}',
  primary key (snapshot_digest, path),
  check (sha256 ~ '^[0-9a-f]{64}$'),
  check (size >= 0),
  check ((file_type = 'symlink' and target is not null) or file_type = 'file')
);

create table system_sources (
  system_id             text primary key references systems(id) on delete cascade,
  current_digest        text not null references source_snapshots(digest),
  upstream_base_digest  text references source_snapshots(digest),
  origin                text,
  discovery             jsonb,
  original_system       jsonb,
  imported_at           timestamptz not null default now()
);

create table node_source_selectors (
  system_id text not null,
  node_id   text not null,
  selector  text not null,
  position  integer not null,
  primary key (system_id, node_id, selector),
  foreign key (system_id, node_id) references nodes(system_id, id) on delete cascade
);

create table artifact_source_paths (
  system_id       text not null,
  artifact_id     text not null,
  snapshot_digest text not null,
  source_path     text not null,
  position        integer not null,
  primary key (system_id, artifact_id, source_path),
  foreign key (system_id, artifact_id) references artifacts(system_id, id) on delete cascade,
  foreign key (snapshot_digest, source_path) references source_files(snapshot_digest, path)
);

create table remote_changes (
  id                uuid primary key default gen_random_uuid(),
  system_id         text not null references systems(id) on delete cascade,
  thread_id         text references threads(id) on delete set null,
  remote_change_id  text,
  base_digest       text not null references source_snapshots(digest),
  result_digest     text not null references source_snapshots(digest),
  submit_url        text not null,
  status_url        text,
  candidate_origin  text,
  status            text not null check (status in ('pending', 'processing', 'ready', 'rejected', 'failed', 'unsupported')),
  phase             text,
  response           jsonb not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index idx_source_files_path on source_files(path);
create index idx_system_sources_digest on system_sources(current_digest);
create index idx_remote_changes_system on remote_changes(system_id, created_at desc);

create or replace function fork_system(
  source_system_id text,
  new_system_id text,
  new_system_name text default null
) returns text as $$
begin
  insert into systems (id, name, spec_version, root_node_id, metadata)
  select new_system_id, coalesce(new_system_name, name), spec_version, root_node_id, metadata
  from systems where id = source_system_id;

  insert into concerns (system_id, name, position, is_baseline, scope)
  select new_system_id, name, position, is_baseline, scope from concerns where system_id = source_system_id;
  insert into nodes (id, system_id, kind, name, parent_id, metadata)
  select id, new_system_id, kind, name, parent_id, metadata from nodes where system_id = source_system_id;
  insert into edges (id, system_id, type, from_node_id, to_node_id, metadata)
  select id, new_system_id, type, from_node_id, to_node_id, metadata from edges where system_id = source_system_id;
  insert into documents (hash, system_id, kind, title, language, text, supersedes, source_type, source_url, source_external_id, source_metadata, source_connected_user_id)
  select hash, new_system_id, kind, title, language, text, supersedes, source_type, source_url, source_external_id, source_metadata, source_connected_user_id
  from documents where system_id = source_system_id;
  insert into matrix_refs (system_id, node_id, concern, ref_type, doc_hash)
  select new_system_id, node_id, concern, ref_type, doc_hash from matrix_refs where system_id = source_system_id;
  insert into artifacts (id, system_id, node_id, concern, type, language, text)
  select id, new_system_id, node_id, concern, type, language, text from artifacts where system_id = source_system_id;
  insert into artifact_files (system_id, artifact_id, file_hash)
  select new_system_id, artifact_id, file_hash from artifact_files where system_id = source_system_id;

  insert into system_sources (system_id, current_digest, upstream_base_digest, origin, discovery, original_system, imported_at)
  select new_system_id, current_digest, upstream_base_digest, origin, discovery, original_system, imported_at
  from system_sources where system_id = source_system_id;
  insert into node_source_selectors (system_id, node_id, selector, position)
  select new_system_id, node_id, selector, position from node_source_selectors where system_id = source_system_id;
  insert into artifact_source_paths (system_id, artifact_id, snapshot_digest, source_path, position)
  select new_system_id, artifact_id, snapshot_digest, source_path, position from artifact_source_paths where system_id = source_system_id;
  insert into remote_changes (system_id, thread_id, remote_change_id, base_digest, result_digest, submit_url, status_url, candidate_origin, status, phase, response, created_at, updated_at)
  select new_system_id, thread_id, remote_change_id, base_digest, result_digest, submit_url, status_url, candidate_origin, status, phase, response, created_at, updated_at
  from remote_changes where system_id = source_system_id;

  return new_system_id;
end;
$$ language plpgsql;
