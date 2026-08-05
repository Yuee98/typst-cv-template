-- Add the company-level AI polish scope introduced after Preview acceptance.
-- The wire contract calls this generic aggregation level "group"; v1 exposes
-- it only for experience companies (company -> projects -> bullets).

alter table public.ai_request_ledger
  drop constraint if exists ai_request_ledger_granularity_check;

alter table public.ai_request_ledger
  add constraint ai_request_ledger_granularity_check
  check (granularity in ('item', 'entry', 'group', 'section'));
