-- BinanceXI POS (by Binance Labs)
-- Public receipt verification via RPC (no direct table access for anon).

begin;

create or replace function public.verify_receipt(p_receipt_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_receipt_id text := nullif(trim(coalesce(p_receipt_id, '')), '');
  v_order public.orders%rowtype;
  v_store_name text;
  v_cashier_name text;
  v_items jsonb;
begin
  if v_receipt_id is null then
    return jsonb_build_object('ok', false, 'error', 'receipt_id_required');
  end if;

  select *
    into v_order
  from public.orders o
  where o.receipt_id = v_receipt_id
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  select s.business_name
    into v_store_name
  from public.store_settings s
  where s.business_id = v_order.business_id
    and s.id = 'default'
  limit 1;

  select p.full_name
    into v_cashier_name
  from public.profiles p
  where p.id = v_order.cashier_id
  limit 1;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'product_name', oi.product_name,
        'quantity', oi.quantity,
        'price_at_sale', oi.price_at_sale,
        'service_note', oi.service_note
      )
    ),
    '[]'::jsonb
  )
    into v_items
  from public.order_items oi
  where oi.order_id = v_order.id;

  return jsonb_build_object(
    'ok', true,
    'business_name', coalesce(v_store_name, ''),
    'cashier_name', coalesce(v_cashier_name, ''),
    'receipt_id', v_order.receipt_id,
    'receipt_number', v_order.receipt_number,
    'status', v_order.status,
    'created_at', v_order.created_at,
    'total_amount', v_order.total_amount,
    'payment_method', v_order.payment_method,
    'items', v_items
  );
end;
$$;

revoke all on function public.verify_receipt(text) from public;
grant execute on function public.verify_receipt(text) to anon, authenticated;

commit;

