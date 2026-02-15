require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const archiver = require('archiver');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Initialize Supabase clients
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

// Owner emails (can't be removed as admin)
const OWNER_EMAILS = (process.env.OWNER_EMAILS || '').split(',').map(e => e.trim().toLowerCase());

// Pricing configuration (in cents)
const PRICING = {
    personal: {
        tier1: { min: 1, max: 5, pricePerUnit: 1000 },   // $10 each
        tier2: { min: 6, max: 11, pricePerUnit: 800 },   // $8 each
        tier3: { min: 12, max: 999, pricePerUnit: 700 }  // $7 each
    },
    business: {
        tier1: { min: 1, max: 5, pricePerUnit: 1000 },
        tier2: { min: 6, max: 11, pricePerUnit: 800 },
        tier3: { min: 12, max: 999, pricePerUnit: 700 }
    },
    shipping: 800,  // $8 flat rate
    freePickupLocation: 'Forbes NSW'
};

// Calculate price for quantity
function calculatePrice(quantity, productType = 'personal') {
    const tiers = PRICING[productType] || PRICING.personal;
    if (quantity >= tiers.tier3.min) return quantity * tiers.tier3.pricePerUnit;
    if (quantity >= tiers.tier2.min) return quantity * tiers.tier2.pricePerUnit;
    return quantity * tiers.tier1.pricePerUnit;
}

// =============================================================================
// STRIPE WEBHOOK (must be before express.json())
// =============================================================================

app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const orderId = session.metadata?.orderId;
        const orderNumber = session.metadata?.orderNumber;

        if (!orderId) {
            console.error('No orderId in webhook metadata');
            return res.json({ received: true });
        }

        console.log(`Payment received for order ${orderNumber}`);

        try {
            // Check idempotency
            const { data: existingOrder } = await supabaseAdmin
                .from('orders')
                .select('status')
                .eq('id', orderId)
                .single();

            if (existingOrder?.status !== 'pending') {
                console.log(`Order ${orderNumber} already processed, skipping`);
                return res.json({ received: true });
            }

            // Update order status to paid
            await supabaseAdmin
                .from('orders')
                .update({
                    status: 'paid',
                    stripe_payment_intent_id: session.payment_intent,
                    stripe_checkout_session_id: session.id,
                    paid_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', orderId);

            // Get order details for notifications
            const { data: order } = await supabaseAdmin
                .from('orders')
                .select('*')
                .eq('id', orderId)
                .single();

            // Update customer stats
            if (order?.customer_id) {
                await supabaseAdmin.rpc('increment_customer_stats', {
                    p_customer_id: order.customer_id,
                    p_order_total: order.total
                });
            }

            // Send notifications
            await sendOrderConfirmationEmail(order);
            await sendAdminNotification(order);

            console.log(`Order ${orderNumber} marked as paid, notifications sent`);

        } catch (err) {
            console.error('Webhook processing error:', err);
            return res.status(500).json({ error: 'Processing failed' });
        }
    }

    res.json({ received: true });
});

// =============================================================================
// MIDDLEWARE
// =============================================================================

app.use(helmet({
    contentSecurityPolicy: false
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', apiLimiter);

// Multer for file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Please upload JPG, PNG, or WebP.'));
        }
    }
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

// Verify admin status
async function verifyAdmin(req, requiredRole = 'admin') {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }

    const token = authHeader.split(' ')[1];

    try {
        const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !user) return null;

        // Check if owner
        if (OWNER_EMAILS.includes(user.email?.toLowerCase())) {
            return { userId: user.id, email: user.email, role: 'owner' };
        }

        // Check admin table
        const { data: admin } = await supabaseAdmin
            .from('admins')
            .select('role')
            .eq('user_id', user.id)
            .single();

        if (!admin) return null;

        // Role hierarchy
        const roleHierarchy = { owner: 4, super_admin: 3, admin: 2, moderator: 1 };
        const requiredLevel = roleHierarchy[requiredRole] || 2;
        const userLevel = roleHierarchy[admin.role] || 0;

        if (userLevel >= requiredLevel) {
            return { userId: user.id, email: user.email, role: admin.role };
        }

        return null;
    } catch (err) {
        console.error('Admin verification error:', err);
        return null;
    }
}

// Log admin actions
async function logAdminAction(adminId, action, targetType, targetId, details = {}) {
    try {
        await supabaseAdmin.from('admin_logs').insert({
            admin_id: adminId,
            action,
            target_type: targetType,
            target_id: targetId,
            details
        });
    } catch (err) {
        console.error('Failed to log admin action:', err);
    }
}

// Generate order number
async function generateOrderNumber() {
    const { data, error } = await supabaseAdmin.rpc('generate_order_number');
    if (error) {
        // Fallback
        const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        return `HS-${date}-${random}`;
    }
    return data;
}

// Send order confirmation email
async function sendOrderConfirmationEmail(order) {
    if (!process.env.RESEND_API_KEY || !order.customer_email) return;

    const trackingUrl = `${process.env.SITE_URL}/track.html?order=${order.order_number}`;

    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #e91e63;">Thanks for your order, ${order.customer_name}!</h1>
            <p>We've received your order and are getting started on your custom magnets.</p>

            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <p><strong>Order Number:</strong> ${order.order_number}</p>
                <p><strong>Product:</strong> ${order.product_type === 'business' ? 'Business Magnets' : 'Personal Magnets'}</p>
                <p><strong>Quantity:</strong> ${order.quantity} magnets</p>
                <p><strong>Total:</strong> $${(order.total / 100).toFixed(2)} AUD</p>
            </div>

            <p><a href="${trackingUrl}" style="display: inline-block; background: #e91e63; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Track Your Order</a></p>

            <p style="color: #666; margin-top: 30px;">Questions? Reply to this email or call us at 0421 191 476.</p>

            <p>- The Heartsnaps Team</p>
        </div>
    `;

    try {
        await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: 'Heartsnaps <orders@heartsnaps.com.au>',
                to: order.customer_email,
                subject: `Order Confirmed: ${order.order_number}`,
                html
            })
        });
    } catch (err) {
        console.error('Failed to send confirmation email:', err);
    }
}

// Send admin notification
async function sendAdminNotification(order) {
    const message = `New Order: ${order.order_number}\n${order.quantity}x ${order.product_type} magnets\nTotal: $${(order.total / 100).toFixed(2)}\nCustomer: ${order.customer_name}`;

    // Push notification via ntfy.sh (free)
    if (process.env.NTFY_TOPIC) {
        try {
            await fetch(`https://ntfy.sh/${process.env.NTFY_TOPIC}`, {
                method: 'POST',
                headers: {
                    'Title': `New Order! ${order.order_number}`,
                    'Priority': 'high',
                    'Tags': 'magnet,moneybag'
                },
                body: message
            });
        } catch (err) {
            console.error('Failed to send push notification:', err);
        }
    }

    // Email to admin
    if (process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
        try {
            await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    from: 'Heartsnaps <orders@heartsnaps.com.au>',
                    to: process.env.ADMIN_EMAIL,
                    subject: `New Order: ${order.order_number} - $${(order.total / 100).toFixed(2)}`,
                    html: `<pre>${message}</pre><p><a href="${process.env.SITE_URL}/admin.html">View in Admin Dashboard</a></p>`
                })
            });
        } catch (err) {
            console.error('Failed to send admin email:', err);
        }
    }
}

// =============================================================================
// PUBLIC API ENDPOINTS
// =============================================================================

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Config (public keys only)
app.get('/api/config', (req, res) => {
    res.json({
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
        stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY
    });
});

// Get pricing
app.get('/api/pricing', (req, res) => {
    res.json({
        personal: [
            { min: 1, max: 5, price: 10.00, label: '$10 each' },
            { min: 6, max: 11, price: 8.00, label: '$8 each (6-pack)' },
            { min: 12, max: 999, price: 7.00, label: '$7 each (12-pack)' }
        ],
        business: [
            { min: 1, max: 5, price: 10.00, label: '$10 each' },
            { min: 6, max: 11, price: 8.00, label: '$8 each (6-pack)' },
            { min: 12, max: 999, price: 7.00, label: '$7 each (12-pack)' }
        ],
        shipping: 8.00,
        freePickupLocation: 'Forbes NSW'
    });
});

// Get gallery items
app.get('/api/gallery', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('gallery_items')
            .select('*')
            .eq('is_active', true)
            .order('display_order');

        if (error) throw error;

        // Generate public URLs for images
        const items = await Promise.all(data.map(async (item) => {
            const { data: urlData } = supabaseAdmin.storage
                .from('gallery')
                .getPublicUrl(item.image_path);
            return { ...item, imageUrl: urlData.publicUrl };
        }));

        res.json(items);
    } catch (err) {
        console.error('Gallery fetch error:', err);
        res.status(500).json({ error: 'Failed to load gallery' });
    }
});

// Validate promo code
app.post('/api/validate-promo', async (req, res) => {
    const { code, subtotal, customerId } = req.body;

    if (!code) {
        return res.status(400).json({ error: 'Promo code required' });
    }

    try {
        const { data: promo, error } = await supabaseAdmin
            .from('promo_codes')
            .select('*')
            .eq('code', code.toUpperCase())
            .eq('is_active', true)
            .single();

        if (error || !promo) {
            return res.status(404).json({ error: 'Invalid promo code' });
        }

        // Check expiry
        if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
            return res.status(400).json({ error: 'Promo code has expired' });
        }

        // Check start date
        if (promo.starts_at && new Date(promo.starts_at) > new Date()) {
            return res.status(400).json({ error: 'Promo code is not yet active' });
        }

        // Check max uses
        if (promo.max_uses && promo.uses_count >= promo.max_uses) {
            return res.status(400).json({ error: 'Promo code has reached its usage limit' });
        }

        // Check minimum order amount
        if (subtotal && subtotal < promo.min_order_amount) {
            return res.status(400).json({
                error: `Minimum order of $${(promo.min_order_amount / 100).toFixed(2)} required`
            });
        }

        // Check per-customer usage
        if (customerId && promo.max_uses_per_customer) {
            const { count } = await supabaseAdmin
                .from('promo_code_usage')
                .select('*', { count: 'exact', head: true })
                .eq('promo_code_id', promo.id)
                .eq('customer_id', customerId);

            if (count >= promo.max_uses_per_customer) {
                return res.status(400).json({ error: 'You have already used this promo code' });
            }
        }

        // Calculate discount
        let discount = 0;
        if (promo.discount_type === 'percentage') {
            discount = Math.floor((subtotal || 0) * (promo.discount_value / 100));
        } else {
            discount = promo.discount_value;
        }

        res.json({
            valid: true,
            promoId: promo.id,
            code: promo.code,
            discountType: promo.discount_type,
            discountValue: promo.discount_value,
            calculatedDiscount: discount,
            description: promo.description
        });

    } catch (err) {
        console.error('Promo validation error:', err);
        res.status(500).json({ error: 'Failed to validate promo code' });
    }
});

// Track order
app.get('/api/track/:orderNumber', async (req, res) => {
    const { orderNumber } = req.params;

    try {
        const { data: order, error } = await supabaseAdmin
            .from('orders')
            .select('order_number, status, product_type, quantity, total, shipping_type, shipping_city, shipping_state, tracking_number, carrier, created_at, paid_at, printed_at, shipped_at, completed_at')
            .eq('order_number', orderNumber.toUpperCase())
            .single();

        if (error || !order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        res.json(order);
    } catch (err) {
        console.error('Track order error:', err);
        res.status(500).json({ error: 'Failed to track order' });
    }
});

// =============================================================================
// CUSTOMER API ENDPOINTS
// =============================================================================

// Upload photo
app.post('/api/upload-photo', upload.single('file'), async (req, res) => {
    try {
        const { orderId, position } = req.body;
        const file = req.file;

        if (!file || !orderId) {
            return res.status(400).json({ error: 'File and orderId required' });
        }

        // Generate path
        const ext = file.originalname.split('.').pop();
        const filePath = `orders/${orderId}/${position}_${Date.now()}.${ext}`;

        // Upload to Supabase Storage
        const { data, error } = await supabaseAdmin.storage
            .from('order-photos')
            .upload(filePath, file.buffer, {
                contentType: file.mimetype,
                upsert: false
            });

        if (error) throw error;

        // Create order_item record
        await supabaseAdmin
            .from('order_items')
            .insert({
                order_id: orderId,
                original_file_path: filePath,
                original_filename: file.originalname,
                file_size: file.size,
                mime_type: file.mimetype,
                position: parseInt(position)
            });

        // Generate signed URL for preview
        const { data: signedUrl } = await supabaseAdmin.storage
            .from('order-photos')
            .createSignedUrl(filePath, 3600);

        res.json({
            success: true,
            path: filePath,
            previewUrl: signedUrl?.signedUrl
        });

    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Create order
app.post('/api/orders', async (req, res) => {
    try {
        const {
            customerName, customerPhone, customerEmail,
            shippingType, shippingAddress,
            productType, quantity,
            isGift, giftMessage, notes,
            promoCode
        } = req.body;

        // Validate required fields
        if (!customerName || !customerPhone || !productType || !quantity) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        if (shippingType === 'delivery' && !shippingAddress) {
            return res.status(400).json({ error: 'Shipping address required for delivery' });
        }

        // Calculate pricing
        const subtotal = calculatePrice(quantity, productType);
        const shippingCost = shippingType === 'pickup' ? 0 : PRICING.shipping;
        let discountAmount = 0;
        let promoCodeId = null;
        let promoCodeUsed = null;

        // Validate promo code if provided
        if (promoCode) {
            const { data: promo } = await supabaseAdmin
                .from('promo_codes')
                .select('*')
                .eq('code', promoCode.toUpperCase())
                .eq('is_active', true)
                .single();

            if (promo) {
                if (promo.discount_type === 'percentage') {
                    discountAmount = Math.floor(subtotal * (promo.discount_value / 100));
                } else {
                    discountAmount = promo.discount_value;
                }
                promoCodeId = promo.id;
                promoCodeUsed = promo.code;
            }
        }

        const total = subtotal + shippingCost - discountAmount;

        // Generate order number
        const orderNumber = await generateOrderNumber();

        // Find or create customer
        let customerId = null;
        const { data: existingCustomer } = await supabaseAdmin
            .from('customers')
            .select('id')
            .eq('phone', customerPhone)
            .single();

        if (existingCustomer) {
            customerId = existingCustomer.id;
            // Update customer info
            await supabaseAdmin
                .from('customers')
                .update({
                    name: customerName,
                    email: customerEmail,
                    default_address_line1: shippingAddress?.line1,
                    default_address_line2: shippingAddress?.line2,
                    default_city: shippingAddress?.city,
                    default_state: shippingAddress?.state,
                    default_postcode: shippingAddress?.postcode,
                    updated_at: new Date().toISOString()
                })
                .eq('id', customerId);
        } else {
            const { data: newCustomer } = await supabaseAdmin
                .from('customers')
                .insert({
                    name: customerName,
                    phone: customerPhone,
                    email: customerEmail,
                    default_address_line1: shippingAddress?.line1,
                    default_address_line2: shippingAddress?.line2,
                    default_city: shippingAddress?.city,
                    default_state: shippingAddress?.state,
                    default_postcode: shippingAddress?.postcode
                })
                .select('id')
                .single();
            customerId = newCustomer?.id;
        }

        // Create order
        const { data: order, error: orderError } = await supabaseAdmin
            .from('orders')
            .insert({
                order_number: orderNumber,
                customer_id: customerId,
                customer_name: customerName,
                customer_phone: customerPhone,
                customer_email: customerEmail,
                shipping_type: shippingType,
                shipping_address_line1: shippingAddress?.line1,
                shipping_address_line2: shippingAddress?.line2,
                shipping_city: shippingAddress?.city,
                shipping_state: shippingAddress?.state,
                shipping_postcode: shippingAddress?.postcode,
                product_type: productType,
                quantity,
                subtotal,
                shipping_cost: shippingCost,
                discount_amount: discountAmount,
                promo_code_id: promoCodeId,
                promo_code_used: promoCodeUsed,
                total,
                is_gift: isGift,
                gift_message: giftMessage,
                notes,
                status: 'pending'
            })
            .select()
            .single();

        if (orderError) throw orderError;

        res.json({
            success: true,
            orderId: order.id,
            orderNumber: order.order_number,
            subtotal,
            shippingCost,
            discountAmount,
            total
        });

    } catch (err) {
        console.error('Create order error:', err);
        res.status(500).json({ error: 'Failed to create order' });
    }
});

// Create checkout session
app.post('/api/create-checkout', async (req, res) => {
    try {
        const { orderId } = req.body;

        if (!orderId) {
            return res.status(400).json({ error: 'Order ID required' });
        }

        // Get order details
        const { data: order, error } = await supabaseAdmin
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .single();

        if (error || !order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        if (order.status !== 'pending') {
            return res.status(400).json({ error: 'Order already processed' });
        }

        // Create line items
        const lineItems = [
            {
                price_data: {
                    currency: 'aud',
                    product_data: {
                        name: `${order.product_type === 'business' ? 'Business' : 'Personal'} Magnets x${order.quantity}`,
                        description: `Custom ${order.quantity} photo magnet${order.quantity > 1 ? 's' : ''} (63.5mm x 63.5mm)`
                    },
                    unit_amount: order.subtotal
                },
                quantity: 1
            }
        ];

        // Add shipping if applicable
        if (order.shipping_cost > 0) {
            lineItems.push({
                price_data: {
                    currency: 'aud',
                    product_data: {
                        name: 'Shipping',
                        description: 'Australia-wide flat rate shipping'
                    },
                    unit_amount: order.shipping_cost
                },
                quantity: 1
            });
        }

        // Add discount if applicable
        let discounts = [];
        if (order.discount_amount > 0 && order.promo_code_used) {
            // Create a coupon for this specific discount
            const coupon = await stripe.coupons.create({
                amount_off: order.discount_amount,
                currency: 'aud',
                name: `Promo: ${order.promo_code_used}`,
                duration: 'once'
            });
            discounts = [{ coupon: coupon.id }];
        }

        // Create Stripe checkout session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: lineItems,
            discounts,
            mode: 'payment',
            success_url: `${process.env.SITE_URL}/track.html?order=${order.order_number}&success=true`,
            cancel_url: `${process.env.SITE_URL}/?cancelled=true&order=${orderId}`,
            metadata: {
                orderId: order.id,
                orderNumber: order.order_number
            },
            customer_email: order.customer_email || undefined,
            payment_intent_data: {
                metadata: {
                    orderId: order.id,
                    orderNumber: order.order_number
                }
            }
        });

        res.json({ url: session.url });

    } catch (err) {
        console.error('Create checkout error:', err);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// Look up customer by email/phone
app.post('/api/customer/lookup', async (req, res) => {
    const { email, phone } = req.body;

    if (!email && !phone) {
        return res.status(400).json({ error: 'Email or phone required' });
    }

    try {
        let query = supabaseAdmin.from('customers').select('*');

        if (email) {
            query = query.eq('email', email);
        } else if (phone) {
            query = query.eq('phone', phone);
        }

        const { data: customer, error } = await query.single();

        if (error || !customer) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Get their orders
        const { data: orders } = await supabaseAdmin
            .from('orders')
            .select('order_number, product_type, quantity, total, status, created_at')
            .eq('customer_id', customer.id)
            .order('created_at', { ascending: false })
            .limit(10);

        res.json({
            customer: {
                name: customer.name,
                phone: customer.phone,
                email: customer.email,
                address: {
                    line1: customer.default_address_line1,
                    line2: customer.default_address_line2,
                    city: customer.default_city,
                    state: customer.default_state,
                    postcode: customer.default_postcode
                }
            },
            orders: orders || []
        });

    } catch (err) {
        console.error('Customer lookup error:', err);
        res.status(500).json({ error: 'Lookup failed' });
    }
});

// =============================================================================
// ADMIN API ENDPOINTS
// =============================================================================

// Check admin status
app.get('/api/admin/check', async (req, res) => {
    const admin = await verifyAdmin(req);
    if (!admin) {
        return res.status(403).json({ isAdmin: false });
    }
    res.json({ isAdmin: true, role: admin.role, email: admin.email });
});

// Get dashboard stats
app.get('/api/admin/stats', async (req, res) => {
    const admin = await verifyAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Unauthorized' });

    try {
        const { data: orders } = await supabaseAdmin
            .from('orders')
            .select('id, status, total, product_type, created_at');

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekStart = new Date(todayStart);
        weekStart.setDate(weekStart.getDate() - 7);
        const monthStart = new Date(todayStart);
        monthStart.setMonth(monthStart.getMonth() - 1);

        const paidOrders = orders.filter(o => o.status !== 'pending' && o.status !== 'cancelled');

        const stats = {
            orders: {
                total: orders.length,
                pending: orders.filter(o => o.status === 'pending').length,
                paid: orders.filter(o => o.status === 'paid').length,
                printing: orders.filter(o => o.status === 'printing').length,
                shipped: orders.filter(o => o.status === 'shipped').length,
                ready_pickup: orders.filter(o => o.status === 'ready_pickup').length,
                completed: orders.filter(o => o.status === 'completed').length,
                cancelled: orders.filter(o => o.status === 'cancelled').length,
                needsAction: orders.filter(o => ['paid'].includes(o.status)).length
            },
            revenue: {
                total: paidOrders.reduce((sum, o) => sum + o.total, 0),
                today: paidOrders.filter(o => new Date(o.created_at) >= todayStart).reduce((sum, o) => sum + o.total, 0),
                week: paidOrders.filter(o => new Date(o.created_at) >= weekStart).reduce((sum, o) => sum + o.total, 0),
                month: paidOrders.filter(o => new Date(o.created_at) >= monthStart).reduce((sum, o) => sum + o.total, 0)
            },
            products: {
                personal: orders.filter(o => o.product_type === 'personal').length,
                business: orders.filter(o => o.product_type === 'business').length
            }
        };

        const { count: customerCount } = await supabaseAdmin
            .from('customers')
            .select('*', { count: 'exact', head: true });

        stats.customers = { total: customerCount };

        res.json(stats);

    } catch (err) {
        console.error('Stats error:', err);
        res.status(500).json({ error: 'Failed to load stats' });
    }
});

// List orders
app.get('/api/admin/orders', async (req, res) => {
    const admin = await verifyAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Unauthorized' });

    const { status, limit = 50, offset = 0 } = req.query;

    try {
        let query = supabaseAdmin
            .from('orders')
            .select('*')
            .order('created_at', { ascending: false })
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (status && status !== 'all') {
            query = query.eq('status', status);
        }

        const { data: orders, error } = await query;

        if (error) throw error;

        res.json(orders);

    } catch (err) {
        console.error('List orders error:', err);
        res.status(500).json({ error: 'Failed to load orders' });
    }
});

// Get single order with items
app.get('/api/admin/orders/:id', async (req, res) => {
    const admin = await verifyAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Unauthorized' });

    try {
        const { data: order, error } = await supabaseAdmin
            .from('orders')
            .select('*')
            .eq('id', req.params.id)
            .single();

        if (error || !order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        // Get order items with signed URLs
        const { data: items } = await supabaseAdmin
            .from('order_items')
            .select('*')
            .eq('order_id', order.id)
            .order('position');

        const itemsWithUrls = await Promise.all((items || []).map(async (item) => {
            const { data: signedUrl } = await supabaseAdmin.storage
                .from('order-photos')
                .createSignedUrl(item.original_file_path, 3600);
            return { ...item, previewUrl: signedUrl?.signedUrl };
        }));

        res.json({ ...order, items: itemsWithUrls });

    } catch (err) {
        console.error('Get order error:', err);
        res.status(500).json({ error: 'Failed to load order' });
    }
});

// Update order status
app.put('/api/admin/orders/:id/status', async (req, res) => {
    const admin = await verifyAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Unauthorized' });

    const { status, tracking_number, carrier, admin_notes } = req.body;
    const validStatuses = ['pending', 'paid', 'printing', 'shipped', 'ready_pickup', 'completed', 'cancelled', 'archived'];

    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    try {
        const updateData = {
            status,
            updated_at: new Date().toISOString()
        };

        if (status === 'printing') updateData.printed_at = new Date().toISOString();
        if (status === 'shipped') updateData.shipped_at = new Date().toISOString();
        if (status === 'ready_pickup') updateData.shipped_at = new Date().toISOString();
        if (status === 'completed') updateData.completed_at = new Date().toISOString();

        if (tracking_number) updateData.tracking_number = tracking_number;
        if (carrier) updateData.carrier = carrier;
        if (admin_notes !== undefined) updateData.admin_notes = admin_notes;

        await supabaseAdmin
            .from('orders')
            .update(updateData)
            .eq('id', req.params.id);

        await logAdminAction(admin.userId, 'update_order_status', 'order', req.params.id, { status, tracking_number });

        // TODO: Send customer notification for shipped/ready_pickup

        res.json({ success: true });

    } catch (err) {
        console.error('Update status error:', err);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// Download order photos as ZIP
app.get('/api/admin/orders/:id/download', async (req, res) => {
    const admin = await verifyAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Unauthorized' });

    try {
        const { data: items } = await supabaseAdmin
            .from('order_items')
            .select('*')
            .eq('order_id', req.params.id)
            .order('position');

        const { data: order } = await supabaseAdmin
            .from('orders')
            .select('order_number')
            .eq('id', req.params.id)
            .single();

        if (!items || items.length === 0) {
            return res.status(404).json({ error: 'No photos found' });
        }

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${order.order_number}-photos.zip"`);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);

        for (const item of items) {
            const { data: fileData } = await supabaseAdmin.storage
                .from('order-photos')
                .download(item.original_file_path);

            if (fileData) {
                const buffer = await fileData.arrayBuffer();
                archive.append(Buffer.from(buffer), {
                    name: `${item.position + 1}_${item.original_filename}`
                });
            }
        }

        await archive.finalize();

        await logAdminAction(admin.userId, 'download_photos', 'order', req.params.id);

    } catch (err) {
        console.error('Download error:', err);
        res.status(500).json({ error: 'Download failed' });
    }
});

// Delete order (super_admin only)
app.delete('/api/admin/orders/:id', async (req, res) => {
    const admin = await verifyAdmin(req, 'super_admin');
    if (!admin) return res.status(403).json({ error: 'Unauthorized - requires super_admin' });

    try {
        // Get order details first
        const { data: order, error: orderError } = await supabaseAdmin
            .from('orders')
            .select('order_number')
            .eq('id', req.params.id)
            .single();

        if (orderError || !order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        // Get order items to delete photos
        const { data: items } = await supabaseAdmin
            .from('order_items')
            .select('original_file_path')
            .eq('order_id', req.params.id);

        // Delete photos from storage
        if (items && items.length > 0) {
            const filePaths = items.map(item => item.original_file_path);
            await supabaseAdmin.storage
                .from('order-photos')
                .remove(filePaths);
        }

        // Delete order items
        await supabaseAdmin
            .from('order_items')
            .delete()
            .eq('order_id', req.params.id);

        // Delete the order
        await supabaseAdmin
            .from('orders')
            .delete()
            .eq('id', req.params.id);

        await logAdminAction(admin.userId, 'delete_order', 'order', req.params.id, { order_number: order.order_number });

        res.json({ success: true });

    } catch (err) {
        console.error('Delete order error:', err);
        res.status(500).json({ error: 'Failed to delete order' });
    }
});

// List customers
app.get('/api/admin/customers', async (req, res) => {
    const admin = await verifyAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Unauthorized' });

    try {
        const { data: customers, error } = await supabaseAdmin
            .from('customers')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json(customers);

    } catch (err) {
        console.error('List customers error:', err);
        res.status(500).json({ error: 'Failed to load customers' });
    }
});

// Get customer with orders
app.get('/api/admin/customers/:id', async (req, res) => {
    const admin = await verifyAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Unauthorized' });

    try {
        const { data: customer, error } = await supabaseAdmin
            .from('customers')
            .select('*')
            .eq('id', req.params.id)
            .single();

        if (error || !customer) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const { data: orders } = await supabaseAdmin
            .from('orders')
            .select('*')
            .eq('customer_id', customer.id)
            .order('created_at', { ascending: false });

        res.json({ ...customer, orders: orders || [] });

    } catch (err) {
        console.error('Get customer error:', err);
        res.status(500).json({ error: 'Failed to load customer' });
    }
});

// List promo codes
app.get('/api/admin/promo-codes', async (req, res) => {
    const admin = await verifyAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Unauthorized' });

    try {
        const { data: codes, error } = await supabaseAdmin
            .from('promo_codes')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json(codes);

    } catch (err) {
        console.error('List promo codes error:', err);
        res.status(500).json({ error: 'Failed to load promo codes' });
    }
});

// Create promo code
app.post('/api/admin/promo-codes', async (req, res) => {
    const admin = await verifyAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Unauthorized' });

    const { code, discount_type, discount_value, min_order_amount, max_uses, max_uses_per_customer, expires_at, description } = req.body;

    if (!code || !discount_type || !discount_value) {
        return res.status(400).json({ error: 'Code, discount type, and value required' });
    }

    try {
        const { data: promo, error } = await supabaseAdmin
            .from('promo_codes')
            .insert({
                code: code.toUpperCase(),
                discount_type,
                discount_value,
                min_order_amount: min_order_amount || 0,
                max_uses,
                max_uses_per_customer: max_uses_per_customer || 1,
                expires_at,
                description,
                created_by: admin.userId
            })
            .select()
            .single();

        if (error) throw error;

        await logAdminAction(admin.userId, 'create_promo_code', 'promo_code', promo.id, { code: promo.code });

        res.json(promo);

    } catch (err) {
        console.error('Create promo code error:', err);
        res.status(500).json({ error: 'Failed to create promo code' });
    }
});

// Update promo code
app.put('/api/admin/promo-codes/:id', async (req, res) => {
    const admin = await verifyAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Unauthorized' });

    try {
        const { error } = await supabaseAdmin
            .from('promo_codes')
            .update({
                ...req.body,
                updated_at: new Date().toISOString()
            })
            .eq('id', req.params.id);

        if (error) throw error;

        await logAdminAction(admin.userId, 'update_promo_code', 'promo_code', req.params.id);

        res.json({ success: true });

    } catch (err) {
        console.error('Update promo code error:', err);
        res.status(500).json({ error: 'Failed to update promo code' });
    }
});

// Delete (deactivate) promo code
app.delete('/api/admin/promo-codes/:id', async (req, res) => {
    const admin = await verifyAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Unauthorized' });

    try {
        await supabaseAdmin
            .from('promo_codes')
            .update({ is_active: false, updated_at: new Date().toISOString() })
            .eq('id', req.params.id);

        await logAdminAction(admin.userId, 'deactivate_promo_code', 'promo_code', req.params.id);

        res.json({ success: true });

    } catch (err) {
        console.error('Delete promo code error:', err);
        res.status(500).json({ error: 'Failed to delete promo code' });
    }
});

// List admins
app.get('/api/admin/admins', async (req, res) => {
    const admin = await verifyAdmin(req, 'super_admin');
    if (!admin) return res.status(403).json({ error: 'Unauthorized' });

    try {
        const { data: admins, error } = await supabaseAdmin
            .from('admins')
            .select('*')
            .order('created_at');

        if (error) throw error;

        // Get user emails
        const adminList = [];
        for (const a of admins) {
            const { data: { user } } = await supabaseAdmin.auth.admin.getUserById(a.user_id);
            adminList.push({
                ...a,
                email: user?.email,
                isOwner: OWNER_EMAILS.includes(user?.email?.toLowerCase())
            });
        }

        // Add owners who might not be in admins table
        for (const ownerEmail of OWNER_EMAILS) {
            if (!adminList.find(a => a.email?.toLowerCase() === ownerEmail)) {
                adminList.unshift({ email: ownerEmail, role: 'owner', isOwner: true });
            }
        }

        res.json(adminList);

    } catch (err) {
        console.error('List admins error:', err);
        res.status(500).json({ error: 'Failed to load admins' });
    }
});

// Add admin
app.post('/api/admin/admins', async (req, res) => {
    const admin = await verifyAdmin(req, 'super_admin');
    if (!admin) return res.status(403).json({ error: 'Unauthorized' });

    const { email, role = 'admin' } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email required' });
    }

    // Prevent adding someone as owner
    if (role === 'owner') {
        return res.status(400).json({ error: 'Cannot assign owner role' });
    }

    try {
        // Find user by email
        const { data: { users } } = await supabaseAdmin.auth.admin.listUsers();
        const user = users.find(u => u.email?.toLowerCase() === email.toLowerCase());

        if (!user) {
            return res.status(404).json({ error: 'User not found. They must sign up first.' });
        }

        // Check if already admin
        const { data: existing } = await supabaseAdmin
            .from('admins')
            .select('id')
            .eq('user_id', user.id)
            .single();

        if (existing) {
            return res.status(400).json({ error: 'User is already an admin' });
        }

        // Add admin
        const { error } = await supabaseAdmin
            .from('admins')
            .insert({
                user_id: user.id,
                role,
                created_by: admin.userId
            });

        if (error) throw error;

        await logAdminAction(admin.userId, 'add_admin', 'admin', user.id, { email, role });

        res.json({ success: true });

    } catch (err) {
        console.error('Add admin error:', err);
        res.status(500).json({ error: 'Failed to add admin' });
    }
});

// Remove admin
app.delete('/api/admin/admins/:userId', async (req, res) => {
    const admin = await verifyAdmin(req, 'super_admin');
    if (!admin) return res.status(403).json({ error: 'Unauthorized' });

    const { userId } = req.params;

    try {
        // Get user email to check if owner
        const { data: { user } } = await supabaseAdmin.auth.admin.getUserById(userId);

        if (OWNER_EMAILS.includes(user?.email?.toLowerCase())) {
            return res.status(400).json({ error: 'Cannot remove owner' });
        }

        await supabaseAdmin
            .from('admins')
            .delete()
            .eq('user_id', userId);

        await logAdminAction(admin.userId, 'remove_admin', 'admin', userId);

        res.json({ success: true });

    } catch (err) {
        console.error('Remove admin error:', err);
        res.status(500).json({ error: 'Failed to remove admin' });
    }
});

// Get admin logs
app.get('/api/admin/logs', async (req, res) => {
    const admin = await verifyAdmin(req, 'super_admin');
    if (!admin) return res.status(403).json({ error: 'Unauthorized' });

    try {
        const { data: logs, error } = await supabaseAdmin
            .from('admin_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) throw error;

        res.json(logs);

    } catch (err) {
        console.error('Get logs error:', err);
        res.status(500).json({ error: 'Failed to load logs' });
    }
});

// Gallery management
app.post('/api/admin/gallery', upload.single('file'), async (req, res) => {
    const admin = await verifyAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Unauthorized' });

    try {
        const file = req.file;
        const { caption, category } = req.body;

        if (!file) {
            return res.status(400).json({ error: 'Image required' });
        }

        const ext = file.originalname.split('.').pop();
        const filePath = `${Date.now()}.${ext}`;

        // Upload to public gallery bucket
        const { error: uploadError } = await supabaseAdmin.storage
            .from('gallery')
            .upload(filePath, file.buffer, {
                contentType: file.mimetype
            });

        if (uploadError) throw uploadError;

        // Create gallery item
        const { data: item, error } = await supabaseAdmin
            .from('gallery_items')
            .insert({
                image_path: filePath,
                caption,
                category: category || 'personal'
            })
            .select()
            .single();

        if (error) throw error;

        await logAdminAction(admin.userId, 'add_gallery_item', 'gallery', item.id);

        res.json(item);

    } catch (err) {
        console.error('Add gallery error:', err);
        res.status(500).json({ error: 'Failed to add gallery item' });
    }
});

app.delete('/api/admin/gallery/:id', async (req, res) => {
    const admin = await verifyAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Unauthorized' });

    try {
        // Get image path first
        const { data: item } = await supabaseAdmin
            .from('gallery_items')
            .select('image_path')
            .eq('id', req.params.id)
            .single();

        if (item) {
            // Delete from storage
            await supabaseAdmin.storage
                .from('gallery')
                .remove([item.image_path]);
        }

        // Delete from database
        await supabaseAdmin
            .from('gallery_items')
            .delete()
            .eq('id', req.params.id);

        await logAdminAction(admin.userId, 'remove_gallery_item', 'gallery', req.params.id);

        res.json({ success: true });

    } catch (err) {
        console.error('Delete gallery error:', err);
        res.status(500).json({ error: 'Failed to delete gallery item' });
    }
});

// =============================================================================
// SERVE FRONTEND
// =============================================================================

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, () => {
    console.log(`Heartsnaps server running on port ${PORT}`);
});

