-- OpsBase: let signed-in users and the recap script's secret key create rows.
-- Fixes "permission denied for sequence issues_id_seq". Safe to run again.
-- Access rules (who can see/change what) still apply to signed-in users.
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on public.stores, public.issues, public.issue_comments,
  public.profiles, public.store_assignments to authenticated, service_role;
grant usage, select on sequence public.issues_id_seq, public.issue_comments_id_seq to authenticated, service_role;
grant execute on function public.my_role(), public.can_see_store(text), public.set_my_name(text),
  public.my_name(), public.resolve_issue(bigint, text), public.review_issue(bigint, boolean, text),
  public.reopen_issue(bigint, text), public.add_issue_comment(bigint, text) to authenticated, service_role;
