-- =============================================================================
-- HEARTSNAPS - SUPABASE SCHEMA
-- =============================================================================
-- Run this in Supabase SQL Editor
-- Safe to run multiple times (uses IF NOT EXISTS)
-- =============================================================================


-- =============================================================================
-- PROMO CODES TABLE (must be created first for foreign key)
-- =============================================================================

CREATE TABLE IF NOT EXISTS promo_codes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    discount_type TEXT NOT NULL,  -- 'percentage' or 'fixed'
    discount_value INTEGER NOT NULL,  -- percentage (10 = 10%) or cents (500 = $5)
    min_order_amount INTEGER DEFAULT 0,
    max_uses INTEGER,
    uses_count INTEGER DEFAULT 0,
    max_uses_per_customer INTEGER DEFAULT 1,
    is_active BOOLEAN DEFAULT true,
    starts_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    description TEXT,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);
CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes(is_active);

ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to promo_codes" ON promo_codes;
CREATE POLICY "Service role full access to promo_codes" ON promo_codes FOR ALL USING (true);


-- =============================================================================
-- CUSTOMERS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS customers (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    email TEXT,
    phone TEXT NOT NULL,
    name TEXT NOT NULL,
    default_address_line1 TEXT,
    default_address_line2 TEXT,
    default_city TEXT,
    default_state TEXT,
    default_postcode TEXT,
    default_country TEXT DEFAULT 'Australia',
    order_count INTEGER DEFAULT 0,
    total_spent INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_user_id ON customers(user_id);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own customer record" ON customers;
CREATE POLICY "Users can view own customer record" ON customers FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own customer record" ON customers;
CREATE POLICY "Users can update own customer record" ON customers FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access to customers" ON customers;
CREATE POLICY "Service role full access to customers" ON customers FOR ALL USING (true);


-- =============================================================================
-- ORDERS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS orders (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    order_number TEXT UNIQUE NOT NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,

    -- Customer snapshot
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    customer_email TEXT,

    -- Shipping details
    shipping_type TEXT NOT NULL DEFAULT 'delivery',
    shipping_address_line1 TEXT,
    shipping_address_line2 TEXT,
    shipping_city TEXT,
    shipping_state TEXT,
    shipping_postcode TEXT,
    shipping_country TEXT DEFAULT 'Australia',

    -- Gift option
    is_gift BOOLEAN DEFAULT false,
    gift_message TEXT,

    -- Product details
    product_type TEXT NOT NULL,
    quantity INTEGER NOT NULL,

    -- Pricing (all in cents)
    subtotal INTEGER NOT NULL,
    shipping_cost INTEGER NOT NULL DEFAULT 800,
    discount_amount INTEGER DEFAULT 0,
    promo_code_id UUID REFERENCES promo_codes(id),
    promo_code_used TEXT,
    total INTEGER NOT NULL,

    -- Order notes
    notes TEXT,
    admin_notes TEXT,

    -- Status tracking
    status TEXT NOT NULL DEFAULT 'pending',
    stripe_payment_intent_id TEXT,
    stripe_checkout_session_id TEXT,
    tracking_number TEXT,
    carrier TEXT,

    -- Timestamps
    paid_at TIMESTAMPTZ,
    printed_at TIMESTAMPTZ,
    shipped_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can view orders by order_number" ON orders;
CREATE POLICY "Public can view orders by order_number" ON orders FOR SELECT USING (true);

DROP POLICY IF EXISTS "Service role full access to orders" ON orders;
CREATE POLICY "Service role full access to orders" ON orders FOR ALL USING (true);


-- =============================================================================
-- ORDER ITEMS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS order_items (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    original_file_path TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    file_size INTEGER,
    mime_type TEXT,
    width INTEGER,
    height INTEGER,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to order_items" ON order_items;
CREATE POLICY "Service role full access to order_items" ON order_items FOR ALL USING (true);


-- =============================================================================
-- PROMO CODE USAGE TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS promo_code_usage (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    promo_code_id UUID NOT NULL REFERENCES promo_codes(id),
    order_id UUID NOT NULL REFERENCES orders(id),
    customer_id UUID REFERENCES customers(id),
    discount_applied INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_usage_code ON promo_code_usage(promo_code_id);
CREATE INDEX IF NOT EXISTS idx_promo_usage_customer ON promo_code_usage(customer_id);

ALTER TABLE promo_code_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to promo_code_usage" ON promo_code_usage;
CREATE POLICY "Service role full access to promo_code_usage" ON promo_code_usage FOR ALL USING (true);


-- =============================================================================
-- ADMINS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS admins (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
    role TEXT NOT NULL DEFAULT 'admin',
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admins_user_id ON admins(user_id);
CREATE INDEX IF NOT EXISTS idx_admins_role ON admins(role);

ALTER TABLE admins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to admins" ON admins;
CREATE POLICY "Service role full access to admins" ON admins FOR ALL USING (true);


-- =============================================================================
-- ADMIN LOGS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    admin_id UUID REFERENCES auth.users(id),
    action TEXT NOT NULL,
    target_type TEXT,
    target_id UUID,
    details JSONB,
    ip_address TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_logs_admin_id ON admin_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_created_at ON admin_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_logs_action ON admin_logs(action);

ALTER TABLE admin_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to admin_logs" ON admin_logs;
CREATE POLICY "Service role full access to admin_logs" ON admin_logs FOR ALL USING (true);


-- =============================================================================
-- GALLERY ITEMS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS gallery_items (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    image_path TEXT NOT NULL,
    caption TEXT,
    category TEXT DEFAULT 'personal',
    is_featured BOOLEAN DEFAULT false,
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE gallery_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view active gallery items" ON gallery_items;
CREATE POLICY "Anyone can view active gallery items" ON gallery_items FOR SELECT USING (is_active = true);

DROP POLICY IF EXISTS "Service role full access to gallery_items" ON gallery_items;
CREATE POLICY "Service role full access to gallery_items" ON gallery_items FOR ALL USING (true);


-- =============================================================================
-- HELPER FUNCTIONS
-- =============================================================================

-- Function to generate order numbers
CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS TEXT AS $$
DECLARE
    today_date TEXT;
    today_count INTEGER;
    new_number TEXT;
BEGIN
    today_date := TO_CHAR(NOW() AT TIME ZONE 'Australia/Sydney', 'YYYYMMDD');

    SELECT COUNT(*) + 1 INTO today_count
    FROM orders
    WHERE order_number LIKE 'HS-' || today_date || '-%';

    new_number := 'HS-' || today_date || '-' || LPAD(today_count::TEXT, 3, '0');

    RETURN new_number;
END;
$$ LANGUAGE plpgsql;

-- Function to calculate order price (in cents)
CREATE OR REPLACE FUNCTION calculate_order_price(qty INTEGER)
RETURNS INTEGER AS $$
BEGIN
    IF qty >= 12 THEN
        RETURN qty * 700;  -- $7 each
    ELSIF qty >= 6 THEN
        RETURN qty * 800;  -- $8 each
    ELSE
        RETURN qty * 1000; -- $10 each
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to increment customer stats
CREATE OR REPLACE FUNCTION increment_customer_stats(p_customer_id UUID, p_order_total INTEGER)
RETURNS VOID AS $$
BEGIN
    UPDATE customers
    SET
        order_count = order_count + 1,
        total_spent = total_spent + p_order_total,
        updated_at = NOW()
    WHERE id = p_customer_id;
END;
$$ LANGUAGE plpgsql;


-- =============================================================================
-- STORAGE BUCKETS (run these in Supabase dashboard or via API)
-- =============================================================================
-- 1. Create bucket: order-photos (private)
-- 2. Create bucket: gallery (public)
--
-- Storage policies for order-photos:
-- - Allow authenticated uploads
-- - Allow service role full access
-- - Allow admin downloads


-- =============================================================================
-- DONE!
-- =============================================================================
