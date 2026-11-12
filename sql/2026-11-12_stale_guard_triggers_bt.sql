-- BT（高松）
do $$ declare t text; begin
  foreach t in array array['bt_tasks','bt_reservations'] loop
    execute format('drop trigger if exists a0b_hdm_stale on public.%I', t);
    execute format('create trigger a0b_hdm_stale before update on public.%I for each row execute function public._hdm_stale_guard()', t);
    execute format('drop trigger if exists zzzz_hdm_touch on public.%I', t);
    execute format('create trigger zzzz_hdm_touch after update on public.%I for each row execute function public._hdm_touch()', t);
  end loop; end $$;
