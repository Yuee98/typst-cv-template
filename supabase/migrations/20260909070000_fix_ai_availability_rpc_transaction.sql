-- PostgREST executes STABLE RPCs in READ ONLY transactions, including POST.
-- The V2 reader delegates to V1, whose route validation takes FOR SHARE locks.
-- In READ ONLY mode those locks fail and the reader masks the exception as
-- disabled availability. Match V1's volatility so HTTP callers can take the
-- existing locks without changing routing, authorization or stored config.
begin;

alter function public.get_ai_polish_availability_v2(uuid) volatile;

notify pgrst, 'reload schema';

commit;
