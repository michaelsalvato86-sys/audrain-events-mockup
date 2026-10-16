-- Admin portal read RPCs (ADMIN, 2026-10-16) - proposals for BACKEND to merge into a 07-*.sql file. Concours only.
-- Assumes the 07 additions in the build contract (order_lines, passes, comp_pools, revocations, gates.zone,
-- ticket_types.gl_code/kind). Columns the contract leaves open (comps.reason_code/note/pool_id, scans.device_time/
-- offline, revocations.by_user, orders.promo_code) are read with to_jsonb(row)->> so this compiles either way.
-- All admin only: non-admins get [] / null. Amounts in cents; the portal formats dollars.

-- -------------------------------------------------------------------------------------
-- Audit trail for catalogue / promo / vehicle-token changes. The portal sends `_reason` inside the jsonb of
-- admin_upsert_event, admin_upsert_ticket_type, admin_upsert_promo and admin_upsert_vehicle (rotate_token).
-- Suggested: those RPCs insert a row here when publish, price, sales_open, a promo or a token changes.
create table if not exists tix.admin_log (
  id bigint generated always as identity primary key,
  app text not null,
  at timestamptz not null default now(),
  by_user uuid references auth.users(id),
  kind text not null,          -- event_publish | ticket_type_price | ticket_type_sales | promo | pool | vehicle_token
  target text,                 -- slug / ticket type name / promo code / vehicle name
  reason text,
  details jsonb not null default '{}'::jsonb
);
alter table tix.admin_log enable row level security;
drop policy if exists "admin log" on tix.admin_log;
create policy "admin log" on tix.admin_log for select using (staff.has_role(app, 'admin'));
grant select on tix.admin_log to authenticated;
grant all on tix.admin_log to service_role;

-- -------------------------------------------------------------------------------------
-- Order detail: the order row, lines, tickets (with pass serial and scans) and refunds.
create or replace function tix.admin_order_detail(p_order_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when not staff.has_role(o.app, 'admin') then null else jsonb_build_object(
    'order', to_jsonb(o),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('ticket_type_id', l.ticket_type_id, 'name', tt.name, 'qty', l.qty,
        'unit_cents', l.unit_cents, 'tax_cents', l.tax_cents, 'gl_code', tt.gl_code, 'holder_names', l.holder_names) order by tt.sort, tt.name)
      from tix.order_lines l left join tix.ticket_types tt on tt.id = l.ticket_type_id where l.order_id = o.id), '[]'::jsonb),
    'tickets', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'serial', t.serial, 'pass_serial', p.serial, 'status', t.status,
        'holder_name', t.holder_name, 'ticket_type_id', t.ticket_type_id, 'type', tt.name, 'gl_code', tt.gl_code, 'is_comp', t.is_comp,
        'scans', coalesce((select jsonb_agg(jsonb_build_object('scanned_at', s.scanned_at, 'gate', s.gate, 'result', s.result) order by s.scanned_at)
          from tix.scans s where s.ticket_id = t.id or (p.serial is not null and s.serial = p.serial)), '[]'::jsonb)) order by t.issued_at)
      from tix.tickets t left join tix.passes p on p.id = t.pass_id left join tix.ticket_types tt on tt.id = t.ticket_type_id
      where t.order_id = o.id), '[]'::jsonb),
    'refunds', coalesce((select jsonb_agg(jsonb_build_object('created_at', r.created_at, 'amount_cents', r.amount_cents, 'reason', r.reason,
        'status', r.status, 'ticket_id', r.ticket_id, 'stripe_refund_id', r.stripe_refund_id) order by r.created_at)
      from tix.refunds r where r.order_id = o.id), '[]'::jsonb)) end
  from tix.orders o where o.id = p_order_id $$;

-- -------------------------------------------------------------------------------------
-- Finance exports. p_kind = orders | tickets | comps | scans. p_from inclusive, p_to exclusive (null = open).
-- Every row carries payment_ref / stripe_payment_intent and gl_code(s) for reconciliation against Stripe.
create or replace function tix.admin_export(p_app text, p_kind text, p_from timestamptz default null, p_to timestamptz default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
  if not staff.has_role(p_app, 'admin') then raise exception 'Admins only'; end if;
  if p_kind = 'orders' then
    select jsonb_agg(jsonb_build_object(
        'order_id', o.id, 'created_at', o.created_at, 'status', o.status, 'channel', o.channel, 'buyer_name', o.buyer_name,
        'buyer_email', o.buyer_email, 'subtotal_cents', o.subtotal_cents, 'discount_cents', o.discount_cents, 'tax_cents', o.tax_cents,
        'fees_cents', o.fees_cents, 'total_cents', o.total_cents,
        'refunded_cents', (select coalesce(sum(r.amount_cents), 0) from tix.refunds r where r.order_id = o.id and r.status in ('done','pending_stripe')),
        'payment_method', o.payment_method, 'payment_ref', o.payment_ref, 'stripe_payment_intent', o.stripe_payment_intent,
        'gl_codes', coalesce(
          (select jsonb_agg(distinct tt.gl_code) from tix.order_lines l join tix.ticket_types tt on tt.id = l.ticket_type_id
            where l.order_id = o.id and tt.gl_code is not null),
          (select jsonb_agg(distinct tt.gl_code) from tix.tickets t join tix.ticket_types tt on tt.id = t.ticket_type_id
            where t.order_id = o.id and tt.gl_code is not null)),
        'promo_code', to_jsonb(o)->>'promo_code',
        'utm_campaign', coalesce(o.attribution->>'utm_campaign', o.attribution->'utm'->>'utm_campaign'),
        'entity', 'concours_foundation') order by o.created_at)
      into res from tix.orders o
     where o.app = p_app and (p_from is null or o.created_at >= p_from) and (p_to is null or o.created_at < p_to);
  elsif p_kind = 'tickets' then
    select jsonb_agg(jsonb_build_object(
        'ticket_id', t.id, 'serial', t.serial, 'pass_serial', p.serial, 'order_id', t.order_id, 'event', e.title, 'ticket_type', tt.name,
        'kind', tt.kind, 'gl_code', tt.gl_code, 'status', t.status, 'is_comp', t.is_comp,
        'unit_cents', case when t.is_comp then 0 else coalesce(l.unit_cents, tt.price_cents) end,
        -- order_lines.tax_cents is taken as the line total, so one ticket carries tax / qty
        'tax_cents', case when t.is_comp or l.qty is null then 0 else l.tax_cents / greatest(l.qty, 1) end,
        'holder_name', t.holder_name, 'buyer_email', o.buyer_email, 'issued_at', t.issued_at,
        'payment_ref', o.payment_ref, 'stripe_payment_intent', o.stripe_payment_intent,
        'came_in', exists (select 1 from tix.scans s where s.result = 'valid' and (s.ticket_id = t.id or (p.serial is not null and s.serial = p.serial))))
        order by t.issued_at)
      into res from tix.tickets t
      left join tix.orders o on o.id = t.order_id
      left join tix.passes p on p.id = t.pass_id
      left join tix.ticket_types tt on tt.id = t.ticket_type_id
      left join tix.events e on e.id = tt.event_id
      left join lateral (select x.unit_cents, x.tax_cents, x.qty from tix.order_lines x
                          where x.order_id = t.order_id and x.ticket_type_id = t.ticket_type_id limit 1) l on true
     where t.app = p_app and (p_from is null or t.issued_at >= p_from) and (p_to is null or t.issued_at < p_to);
  elsif p_kind = 'comps' then
    select jsonb_agg(jsonb_build_object(
        'comp_id', c.id, 'created_at', c.created_at, 'issued_by_email', (select u.email from auth.users u where u.id = c.issued_by),
        'recipient_email', coalesce(to_jsonb(c)->>'recipient_email', t.reserved_email, (select u.email from auth.users u where u.id = t.owner_user_id)),
        'recipient_name', coalesce(c.recipient, t.holder_name),
        'reason_code', coalesce(to_jsonb(c)->>'reason_code', c.reason), 'note', to_jsonb(c)->>'note',
        'pool', (select cp.name from tix.comp_pools cp where cp.id::text = to_jsonb(c)->>'pool_id'),
        'event', e.title, 'ticket_type', tt.name, 'gl_code', tt.gl_code, 'face_value_cents', tt.price_cents,
        'serial', t.serial, 'status', t.status,
        'came_in', exists (select 1 from tix.scans s where s.result = 'valid' and (s.ticket_id = t.id
                     or s.serial = (select p.serial from tix.passes p where p.id = t.pass_id))))
        order by c.created_at)
      into res from tix.comps c
      left join tix.tickets t on t.id = c.ticket_id
      left join tix.ticket_types tt on tt.id = t.ticket_type_id
      left join tix.events e on e.id = tt.event_id
     where c.app = p_app and (p_from is null or c.created_at >= p_from) and (p_to is null or c.created_at < p_to);
  elsif p_kind = 'scans' then
    select jsonb_agg(jsonb_build_object(
        'scan_id', s.id, 'scanned_at', s.scanned_at, 'device_time', to_jsonb(s)->>'device_time', 'synced_at', s.synced_at,
        'gate', s.gate, 'zone', g.zone, 'serial', s.serial, 'event', e.title, 'ticket_type', tt.name, 'gl_code', tt.gl_code,
        'result', s.result, 'method', s.method, 'offline', to_jsonb(s)->'offline', 'device', s.device,
        'scanned_by_email', (select u.email from auth.users u where u.id = s.scanned_by),
        'order_id', t.order_id, 'payment_ref', o.payment_ref, 'stripe_payment_intent', o.stripe_payment_intent)
        order by s.scanned_at)
      into res from tix.scans s
      left join tix.gates g on g.app = s.app and g.code = s.gate
      left join tix.tickets t on t.id = s.ticket_id
      left join tix.orders o on o.id = t.order_id
      left join tix.ticket_types tt on tt.id = t.ticket_type_id
      left join tix.events e on e.id = tt.event_id
     where s.app = p_app and (p_from is null or s.scanned_at >= p_from) and (p_to is null or s.scanned_at < p_to);
  else
    raise exception 'Unknown export %', p_kind;
  end if;
  return coalesce(res, '[]'::jsonb);
end $$;

-- -------------------------------------------------------------------------------------
-- Audit log: comps, overrides (apply / move / remove / unlock_phone / refund), order-level refunds made by the
-- refund edge function, pass revocations and admin_log rows. Newest first. Who = email of the admin.
create or replace function tix.admin_audit(p_app text, p_limit int default 500) returns jsonb
language sql stable security definer set search_path = '' as $$
  with a as (
    select c.created_at as at, 'comp'::text as kind, c.issued_by as by_user, coalesce(c.recipient, t.reserved_email) as target,
           c.reason || coalesce(' - ' || (to_jsonb(c)->>'note'), '') as reason, t.serial, null::int as amount_cents, '{}'::jsonb as details
      from tix.comps c left join tix.tickets t on t.id = c.ticket_id where c.app = p_app
    union all
    select o.created_at, o.action, o.admin_user, o.target_email, o.reason, t.serial, (o.details->>'amount_cents')::int, o.details
      from tix.overrides o left join tix.tickets t on t.id = o.ticket_id where o.app = p_app
    union all   -- refunds not already logged as an override (order-level refunds from the edge function)
    select r.created_at, 'refund', r.requested_by, (select x.buyer_email from tix.orders x where x.id = r.order_id), r.reason, null, r.amount_cents,
           jsonb_build_object('order_id', r.order_id, 'status', r.status)
      from tix.refunds r where r.app = p_app and r.ticket_id is null
    union all
    select v.at, 'revoke', (to_jsonb(v)->>'by_user')::uuid, null, v.reason, v.serial, null, jsonb_build_object('rev', v.rev)
      from tix.revocations v
     where exists (select 1 from tix.passes p where p.serial = v.serial and p.app = p_app)
    union all
    select l.at, l.kind, l.by_user, l.target, l.reason, null, null, l.details from tix.admin_log l where l.app = p_app)
  select case when not staff.has_role(p_app, 'admin') then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object('at', x.at, 'kind', x.kind, 'by_email', (select u.email from auth.users u where u.id = x.by_user),
             'target', x.target, 'reason', x.reason, 'serial', x.serial, 'amount_cents', x.amount_cents, 'details', x.details) order by x.at desc)
      from (select * from a order by at desc limit least(greatest(coalesce(p_limit, 500), 1), 5000)) x), '[]'::jsonb) end $$;

revoke execute on function tix.admin_order_detail(uuid), tix.admin_export(text, text, timestamptz, timestamptz),
  tix.admin_audit(text, int) from public, anon;
grant execute on function tix.admin_order_detail(uuid), tix.admin_export(text, text, timestamptz, timestamptz),
  tix.admin_audit(text, int) to authenticated;
