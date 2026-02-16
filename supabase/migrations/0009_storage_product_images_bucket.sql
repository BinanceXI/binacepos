-- BinanceXI POS (by Binance Labs)
-- Storage bucket for product images (used by upload_product_image edge function).

begin;

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage.buckets is missing (skipping bucket create)';
  else
    insert into storage.buckets (id, name, public)
    values ('product-images', 'product-images', true)
    on conflict (id) do update
      set name = excluded.name,
          public = excluded.public;
  end if;
end $$;

commit;

