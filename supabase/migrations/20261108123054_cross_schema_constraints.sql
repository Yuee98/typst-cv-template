begin;
set local search_path = '';
alter table ai.configurations
  add constraint fk_config_legal_document foreign key (legal_document_id) references legal.documents (id);
alter table legal.documents
  add constraint fk_document_current_audit foreign key (document_audit_id, id) references audit.documents (audit_id, id) deferrable initially deferred;
alter table legal.acceptances
  add constraint fk_accepted_document_audit foreign key (document_audit_id, document_id) references audit.documents (audit_id, id);
alter table audit.acceptances
  add constraint fk_acceptance_history_document foreign key (document_audit_id, document_id) references audit.documents (audit_id, id);
alter table ai.request_snapshots
  add constraint fk_snapshot_config_audit foreign key (config_audit_id) references audit.configurations (audit_id);
alter table ai.request_snapshots
  add constraint fk_snapshot_common_acceptance foreign key (common_acceptance_audit_id) references audit.acceptances (audit_id);
alter table ai.request_snapshots
  add constraint fk_snapshot_provider_acceptance foreign key (provider_acceptance_audit_id) references audit.acceptances (audit_id);
alter table ai.configuration_usage_daily
  add constraint fk_metric_config_audit foreign key (config_audit_id) references audit.configurations (audit_id);
create index ix_snapshot_common_acceptance on ai.request_snapshots (common_acceptance_audit_id);
create index ix_snapshot_provider_acceptance on ai.request_snapshots (provider_acceptance_audit_id);
create index ix_snapshot_config_audit on ai.request_snapshots (config_audit_id);
create index ix_acceptance_document_audit on legal.acceptances (document_audit_id);
create index ix_audit_acceptance_document_audit on audit.acceptances (document_audit_id);
do $erase$
declare
  r record;
begin
  for r in
  select
    table_name,
    column_name
  from
    information_schema.columns
  where
    table_schema = 'audit'
    and column_name in ('actor_auth_user_id', 'auth_user_id', 'owner_auth_user_id')
    loop
      execute format('alter table audit.%I add constraint %I foreign key(%I) references auth.users(id) on delete set null', r.table_name, 'fk_' || r.table_name || '_' || r.column_name, r.column_name);
      execute format('create index %I on audit.%I(%I) where %I is not null', 'ix_' || r.table_name || '_' || r.column_name, r.table_name, r.column_name, r.column_name);
    end loop;
end
$erase$;
commit;
