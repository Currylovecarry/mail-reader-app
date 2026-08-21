# Supabase setup

1. Create a Supabase project (Singapore is a suitable region for this deployment).
2. In the SQL editor, run `migrations/202608210001_orderbridge.sql`.
3. In **Authentication → Providers**, enable Email and configure the production and preview redirect URLs.
4. Create the Vercel project, connect it to Supabase, and set the variables described in `.env.example`.

`product_catalog` is intentionally empty after the migration. Import the approved business product master before allowing users to confirm matches. The local `test_product_catalog` must not be used as a production product master.
