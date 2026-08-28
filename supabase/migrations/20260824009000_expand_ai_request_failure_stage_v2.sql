-- V2 terminal-attempt finalization copies the immutable child failure stage to
-- its parent request ledger.  The legacy parent constraint predates V2 and
-- therefore must admit both its historical values and every V2 producer value.
--
-- Keep this as a forward-only constraint replacement: historical rows remain
-- valid and no runtime configuration or ledger facts are rewritten here.

begin;

alter table public.ai_request_ledger
  drop constraint ai_request_ledger_failure_stage_check,
  add constraint ai_request_ledger_failure_stage_check check (
    failure_stage in (
      -- Legacy request-lifecycle values.
      'terms',
      'quota',
      'request_validation',
      'provider_http',
      'provider_timeout',
      'json_parse',
      'schema_validation',
      'semantic_validation',
      'canceled',
      -- V2 terminal-attempt producer values.
      'transport',
      'provider_contract',
      'finish_reason',
      'empty_content',
      'id_set_mismatch',
      'empty_item',
      'length_cap',
      'total_length_cap',
      'language_mismatch',
      'protected_spans'
    )
  );

commit;
