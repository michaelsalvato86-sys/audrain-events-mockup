-- Admin portal funnel (ADMIN, 2026-10-16) - for BACKEND to merge into a 07-*.sql file. Concours only.
-- Funnel by campaign: views -> add_to_cart -> checkout -> purchase -> attended.
--   views / add_to_cart / checkout = distinct visitors (visitor_id, else user_id) with that event.
--   purchase = distinct orders; revenue_cents = sum of purchase value_cents.
--   attended = distinct pass serials with an `attended` event.
-- Campaign = utm_campaign on the event itself; for server/gate events that carry no UTM, it falls back to the
-- order's attribution (purchase) or the attribution of the first order on that pass (attended).
-- p_from inclusive, p_to exclusive; null = open-ended. Admin only; others get [].
create or replace function analytics.admin_funnel(p_app text, p_from timestamptz default null, p_to timestamptz default null)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with ev as (
    select a.name, a.order_id, a.serial, a.value_cents,
           coalesce(a.visitor_id, a.user_id::text) as who,
           coalesce(
             nullif(a.utm->>'utm_campaign', ''), nullif(a.utm->>'campaign', ''),
             (select coalesce(nullif(o.attribution->>'utm_campaign', ''), nullif(o.attribution->'utm'->>'utm_campaign', ''))
                from tix.orders o where o.id = a.order_id),
             (select coalesce(nullif(o.attribution->>'utm_campaign', ''), nullif(o.attribution->'utm'->>'utm_campaign', ''))
                from tix.passes p join tix.tickets t on t.pass_id = p.id join tix.orders o on o.id = t.order_id
               where a.serial is not null and p.serial = a.serial and p.app = a.app
               order by o.created_at limit 1),
             '(none)') as campaign
      from analytics.events a
     where a.app = p_app
       and a.name in ('page_view','view_content','add_to_cart','initiate_checkout','purchase','attended')
       and (p_from is null or a.at >= p_from)
       and (p_to is null or a.at < p_to)),
  f as (
    select campaign,
           count(distinct who) filter (where name in ('page_view','view_content')) as views,
           count(distinct who) filter (where name = 'add_to_cart') as add_to_cart,
           count(distinct who) filter (where name = 'initiate_checkout') as checkout,
           count(distinct order_id) filter (where name = 'purchase') as purchase,
           coalesce(sum(value_cents) filter (where name = 'purchase'), 0) as revenue_cents,
           count(distinct serial) filter (where name = 'attended') as attended
      from ev group by campaign)
  select case when not staff.has_role(p_app, 'admin') then '[]'::jsonb
         else coalesce((select jsonb_agg(to_jsonb(f) order by f.purchase desc, f.views desc, f.campaign) from f), '[]'::jsonb) end $$;

revoke execute on function analytics.admin_funnel(text, timestamptz, timestamptz) from public, anon;
grant execute on function analytics.admin_funnel(text, timestamptz, timestamptz) to authenticated;
-- Suggested index if analytics.events grows large:
-- create index if not exists analytics_events_app_at_idx on analytics.events(app, at);
