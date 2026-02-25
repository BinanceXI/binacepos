-- BinanceXI POS (by Binance Labs)
-- Allow hard-deleting staff profiles without deleting order history.

begin;

do $$
begin
  if to_regclass('public.orders') is null then
    return;
  end if;

  -- Replace legacy FK (NO ACTION / RESTRICT) with SET NULL.
  alter table public.orders
    drop constraint if exists orders_cashier_id_fkey;

  -- Defensive cleanup for legacy rows before recreating the FK.
  update public.orders o
    set cashier_id = null
    where o.cashier_id is not null
      and not exists (
        select 1
        from public.profiles p
        where p.id = o.cashier_id
      );

  alter table public.orders
    add constraint orders_cashier_id_fkey
    foreign key (cashier_id)
    references public.profiles (id)
    on delete set null;
end $$;

commit;
