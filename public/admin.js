// =============================================================================
// HEARTSNAPS - ADMIN DASHBOARD
// =============================================================================

let supabaseClient = null;
let currentUser = null;
let adminRole = null;
let authToken = null;

// =============================================================================
// INITIALIZATION
// =============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    await initAdmin();
    setupNavigation();
});

async function initAdmin() {
    try {
        // Fetch config
        const response = await fetch('/api/config');
        const config = await response.json();

        // Initialize Supabase
        supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);

        // Check for existing session
        const { data: { session } } = await supabaseClient.auth.getSession();

        if (session) {
            currentUser = session.user;
            authToken = session.access_token;
            await checkAdminStatus();
        } else {
            showLoginScreen();
        }

        // Listen for auth changes
        supabaseClient.auth.onAuthStateChange(async (event, session) => {
            if (session) {
                currentUser = session.user;
                authToken = session.access_token;
                await checkAdminStatus();
            } else {
                currentUser = null;
                authToken = null;
                adminRole = null;
                showLoginScreen();
            }
        });

    } catch (err) {
        console.error('Init error:', err);
        showLoginScreen();
    }
}

function setupNavigation() {
    document.querySelectorAll('.admin-nav a').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const view = link.dataset.view;
            switchView(view);
        });
    });
}

// =============================================================================
// AUTHENTICATION
// =============================================================================

async function signInWithGoogle() {
    const { error } = await supabaseClient.auth.signInWithOAuth({
        provider: 'google',
        options: {
            redirectTo: 'https://heartsnaps.vercel.app/admin.html'
        }
    });

    if (error) {
        console.error('Sign in error:', error);
        alert('Sign in failed: ' + error.message);
    }
}

async function signOut() {
    await supabaseClient.auth.signOut();
    showLoginScreen();
}

async function checkAdminStatus() {
    try {
        const response = await fetch('/api/admin/check', {
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });

        const data = await response.json();

        if (data.isAdmin) {
            adminRole = data.role;
            showDashboard();
        } else {
            alert('You are not authorized to access this dashboard.');
            await signOut();
        }
    } catch (err) {
        console.error('Admin check error:', err);
        showLoginScreen();
    }
}

function showLoginScreen() {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('admin-dashboard').style.display = 'none';
}

function showDashboard() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('admin-dashboard').style.display = 'flex';
    document.getElementById('admin-email').textContent = currentUser?.email || '';
    loadDashboard();
}

// =============================================================================
// NAVIGATION
// =============================================================================

function switchView(viewName) {
    // Update nav
    document.querySelectorAll('.admin-nav a').forEach(link => {
        link.classList.toggle('active', link.dataset.view === viewName);
    });

    // Update views
    document.querySelectorAll('.admin-view').forEach(view => {
        view.classList.remove('active');
    });
    document.getElementById(`view-${viewName}`).classList.add('active');

    // Load data
    switch (viewName) {
        case 'dashboard':
            loadDashboard();
            break;
        case 'orders':
            loadOrders();
            break;
        case 'customers':
            loadCustomers();
            break;
        case 'promos':
            loadPromoCodes();
            break;
        case 'gallery':
            loadGallery();
            break;
        case 'admins':
            loadAdmins();
            break;
    }
}

// =============================================================================
// API HELPER
// =============================================================================

async function apiCall(endpoint, options = {}) {
    const response = await fetch(endpoint, {
        ...options,
        headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json',
            ...options.headers
        }
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Request failed');
    }

    return response.json();
}

// =============================================================================
// DASHBOARD
// =============================================================================

async function loadDashboard() {
    try {
        const stats = await apiCall('/api/admin/stats');

        document.getElementById('stats-grid').innerHTML = `
            <div class="stat-card">
                <h3>Needs Action</h3>
                <div class="value primary">${stats.orders.needsAction}</div>
            </div>
            <div class="stat-card">
                <h3>Total Orders</h3>
                <div class="value">${stats.orders.total}</div>
            </div>
            <div class="stat-card">
                <h3>Revenue (Today)</h3>
                <div class="value">$${(stats.revenue.today / 100).toFixed(2)}</div>
            </div>
            <div class="stat-card">
                <h3>Revenue (This Week)</h3>
                <div class="value">$${(stats.revenue.week / 100).toFixed(2)}</div>
            </div>
            <div class="stat-card">
                <h3>Revenue (This Month)</h3>
                <div class="value">$${(stats.revenue.month / 100).toFixed(2)}</div>
            </div>
            <div class="stat-card">
                <h3>Total Revenue</h3>
                <div class="value primary">$${(stats.revenue.total / 100).toFixed(2)}</div>
            </div>
            <div class="stat-card">
                <h3>Customers</h3>
                <div class="value">${stats.customers.total}</div>
            </div>
            <div class="stat-card">
                <h3>Personal / Business</h3>
                <div class="value">${stats.products.personal} / ${stats.products.business}</div>
            </div>
        `;

        // Load recent orders
        const orders = await apiCall('/api/admin/orders?limit=5');
        document.getElementById('recent-orders').innerHTML = renderOrdersTable(orders);

    } catch (err) {
        console.error('Dashboard load error:', err);
    }
}

// =============================================================================
// ORDERS
// =============================================================================

async function loadOrders() {
    try {
        const status = document.getElementById('order-status-filter')?.value || 'all';
        const orders = await apiCall(`/api/admin/orders?status=${status}`);
        document.getElementById('orders-table').innerHTML = renderOrdersTable(orders);
    } catch (err) {
        console.error('Orders load error:', err);
    }
}

function renderOrdersTable(orders) {
    if (!orders || orders.length === 0) {
        return '<p class="empty-state">No orders found.</p>';
    }

    return `
        <table class="admin-table">
            <thead>
                <tr>
                    <th>Order</th>
                    <th>Customer</th>
                    <th>Product</th>
                    <th>Qty</th>
                    <th>Total</th>
                    <th>Status</th>
                    <th>Date</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${orders.map(order => `
                    <tr>
                        <td><strong>${order.order_number}</strong></td>
                        <td>${order.customer_name}<br><small>${order.customer_phone}</small></td>
                        <td>${order.product_type}</td>
                        <td>${order.quantity}</td>
                        <td>$${(order.total / 100).toFixed(2)}</td>
                        <td><span class="status-badge ${order.status}">${formatStatus(order.status)}</span></td>
                        <td>${formatDate(order.created_at)}</td>
                        <td>
                            <button class="btn btn-small" onclick="viewOrder('${order.id}')">View</button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

async function viewOrder(orderId) {
    try {
        const order = await apiCall(`/api/admin/orders/${orderId}`);
        renderOrderModal(order);
        document.getElementById('order-modal').classList.add('active');
    } catch (err) {
        console.error('View order error:', err);
        alert('Failed to load order: ' + err.message);
    }
}

function renderOrderModal(order) {
    const statusOptions = ['paid', 'printing', 'shipped', 'ready_pickup', 'completed', 'cancelled'];

    document.getElementById('order-modal-content').innerHTML = `
        <h2>Order ${order.order_number}</h2>

        <div class="order-modal-grid">
            <div class="order-info">
                <h3>Customer Details</h3>
                <p><strong>${order.customer_name}</strong></p>
                <p>${order.customer_phone}</p>
                ${order.customer_email ? `<p>${order.customer_email}</p>` : ''}

                <h3>Delivery</h3>
                ${order.shipping_type === 'pickup' ? `
                    <p>Pickup in Forbes NSW</p>
                ` : `
                    <p>${order.shipping_address_line1}</p>
                    ${order.shipping_address_line2 ? `<p>${order.shipping_address_line2}</p>` : ''}
                    <p>${order.shipping_city}, ${order.shipping_state} ${order.shipping_postcode}</p>
                `}

                ${order.is_gift ? `
                    <h3>Gift Message</h3>
                    <p>${order.gift_message || 'No message'}</p>
                ` : ''}

                ${order.notes ? `
                    <h3>Customer Notes</h3>
                    <p>${order.notes}</p>
                ` : ''}

                <h3>Order Summary</h3>
                <p>Product: ${order.product_type}</p>
                <p>Quantity: ${order.quantity}</p>
                <p>Subtotal: $${(order.subtotal / 100).toFixed(2)}</p>
                <p>Shipping: $${(order.shipping_cost / 100).toFixed(2)}</p>
                ${order.discount_amount > 0 ? `<p>Discount: -$${(order.discount_amount / 100).toFixed(2)} (${order.promo_code_used})</p>` : ''}
                <p><strong>Total: $${(order.total / 100).toFixed(2)}</strong></p>
            </div>

            <div class="order-photos">
                <h3>Photos</h3>
                <div class="photo-grid">
                    ${(order.items || []).map((item, i) => `
                        <div class="photo-item">
                            <img src="${item.previewUrl}" alt="Photo ${i + 1}">
                            <span class="photo-num">${i + 1}</span>
                        </div>
                    `).join('')}
                </div>
                <button class="btn" onclick="downloadPhotos('${order.id}')">Download All Photos (ZIP)</button>
            </div>
        </div>

        <div class="order-actions">
            <h3>Update Status</h3>
            <div class="status-update">
                <select id="status-select">
                    ${statusOptions.map(s => `
                        <option value="${s}" ${s === order.status ? 'selected' : ''}>${formatStatus(s)}</option>
                    `).join('')}
                </select>

                <input type="text" id="tracking-input" placeholder="Tracking number (optional)" value="${order.tracking_number || ''}">

                <button class="btn" onclick="updateOrderStatus('${order.id}')">Update</button>
            </div>

            <h3>Admin Notes</h3>
            <textarea id="admin-notes-input" placeholder="Internal notes...">${order.admin_notes || ''}</textarea>
            <button class="btn btn-small" onclick="saveAdminNotes('${order.id}')">Save Notes</button>
        </div>
    `;
}

function closeOrderModal() {
    document.getElementById('order-modal').classList.remove('active');
}

async function updateOrderStatus(orderId) {
    const status = document.getElementById('status-select').value;
    const tracking_number = document.getElementById('tracking-input').value.trim();

    try {
        await apiCall(`/api/admin/orders/${orderId}/status`, {
            method: 'PUT',
            body: JSON.stringify({ status, tracking_number })
        });

        alert('Status updated!');
        closeOrderModal();
        loadOrders();
    } catch (err) {
        alert('Failed to update: ' + err.message);
    }
}

async function saveAdminNotes(orderId) {
    const admin_notes = document.getElementById('admin-notes-input').value;

    try {
        await apiCall(`/api/admin/orders/${orderId}/status`, {
            method: 'PUT',
            body: JSON.stringify({ status: document.getElementById('status-select').value, admin_notes })
        });
        alert('Notes saved!');
    } catch (err) {
        alert('Failed to save notes: ' + err.message);
    }
}

function downloadPhotos(orderId) {
    window.open(`/api/admin/orders/${orderId}/download?token=${authToken}`, '_blank');
}

// =============================================================================
// CUSTOMERS
// =============================================================================

async function loadCustomers() {
    try {
        const customers = await apiCall('/api/admin/customers');

        document.getElementById('customers-table').innerHTML = `
            <table class="admin-table">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Phone</th>
                        <th>Email</th>
                        <th>Orders</th>
                        <th>Total Spent</th>
                        <th>Joined</th>
                    </tr>
                </thead>
                <tbody>
                    ${customers.map(c => `
                        <tr>
                            <td><strong>${c.name}</strong></td>
                            <td>${c.phone}</td>
                            <td>${c.email || '-'}</td>
                            <td>${c.order_count}</td>
                            <td>$${(c.total_spent / 100).toFixed(2)}</td>
                            <td>${formatDate(c.created_at)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    } catch (err) {
        console.error('Customers load error:', err);
    }
}

// =============================================================================
// PROMO CODES
// =============================================================================

async function loadPromoCodes() {
    try {
        const codes = await apiCall('/api/admin/promo-codes');

        document.getElementById('promos-table').innerHTML = `
            <table class="admin-table">
                <thead>
                    <tr>
                        <th>Code</th>
                        <th>Discount</th>
                        <th>Uses</th>
                        <th>Status</th>
                        <th>Expires</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${codes.map(c => `
                        <tr>
                            <td><strong>${c.code}</strong></td>
                            <td>${c.discount_type === 'percentage' ? c.discount_value + '%' : '$' + (c.discount_value / 100).toFixed(2)}</td>
                            <td>${c.uses_count}${c.max_uses ? '/' + c.max_uses : ''}</td>
                            <td><span class="status-badge ${c.is_active ? 'completed' : 'cancelled'}">${c.is_active ? 'Active' : 'Inactive'}</span></td>
                            <td>${c.expires_at ? formatDate(c.expires_at) : 'Never'}</td>
                            <td>
                                ${c.is_active ? `<button class="btn btn-small" onclick="deactivatePromo('${c.id}')">Deactivate</button>` : ''}
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    } catch (err) {
        console.error('Promo codes load error:', err);
    }
}

function showCreatePromoModal() {
    document.getElementById('promo-modal').classList.add('active');
}

function closePromoModal() {
    document.getElementById('promo-modal').classList.remove('active');
}

async function createPromoCode(event) {
    event.preventDefault();

    const code = document.getElementById('promo-code-input').value.toUpperCase();
    const discount_type = document.getElementById('promo-discount-type').value;
    const discount_value = parseInt(document.getElementById('promo-discount-value').value);
    const max_uses = document.getElementById('promo-max-uses').value ? parseInt(document.getElementById('promo-max-uses').value) : null;
    const expires_at = document.getElementById('promo-expires').value || null;
    const description = document.getElementById('promo-description').value;

    // Convert fixed amount to cents
    const value = discount_type === 'fixed' ? discount_value * 100 : discount_value;

    try {
        await apiCall('/api/admin/promo-codes', {
            method: 'POST',
            body: JSON.stringify({
                code,
                discount_type,
                discount_value: value,
                max_uses,
                expires_at,
                description
            })
        });

        alert('Promo code created!');
        closePromoModal();
        loadPromoCodes();
    } catch (err) {
        alert('Failed to create: ' + err.message);
    }
}

async function deactivatePromo(promoId) {
    if (!confirm('Are you sure you want to deactivate this promo code?')) return;

    try {
        await apiCall(`/api/admin/promo-codes/${promoId}`, { method: 'DELETE' });
        loadPromoCodes();
    } catch (err) {
        alert('Failed to deactivate: ' + err.message);
    }
}

// =============================================================================
// GALLERY
// =============================================================================

async function loadGallery() {
    try {
        const response = await fetch('/api/gallery');
        const items = await response.json();

        document.getElementById('gallery-grid').innerHTML = items.length > 0 ? items.map(item => `
            <div class="gallery-admin-item">
                <img src="${item.imageUrl}" alt="${item.caption || 'Gallery image'}">
                <div class="gallery-item-actions">
                    <span>${item.caption || 'No caption'}</span>
                    <button class="btn btn-small" onclick="deleteGalleryItem('${item.id}')">Delete</button>
                </div>
            </div>
        `).join('') : '<p class="empty-state">No gallery images yet.</p>';

    } catch (err) {
        console.error('Gallery load error:', err);
    }
}

function showUploadGalleryModal() {
    document.getElementById('gallery-modal').classList.add('active');
}

function closeGalleryModal() {
    document.getElementById('gallery-modal').classList.remove('active');
}

async function uploadGalleryImage(event) {
    event.preventDefault();

    const file = document.getElementById('gallery-file-input').files[0];
    const caption = document.getElementById('gallery-caption').value;
    const category = document.getElementById('gallery-category').value;

    if (!file) {
        alert('Please select an image');
        return;
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('caption', caption);
    formData.append('category', category);

    try {
        const response = await fetch('/api/admin/gallery', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`
            },
            body: formData
        });

        if (!response.ok) throw new Error('Upload failed');

        alert('Image uploaded!');
        closeGalleryModal();
        loadGallery();
    } catch (err) {
        alert('Failed to upload: ' + err.message);
    }
}

async function deleteGalleryItem(itemId) {
    if (!confirm('Are you sure you want to delete this image?')) return;

    try {
        await apiCall(`/api/admin/gallery/${itemId}`, { method: 'DELETE' });
        loadGallery();
    } catch (err) {
        alert('Failed to delete: ' + err.message);
    }
}

// =============================================================================
// ADMIN USERS
// =============================================================================

async function loadAdmins() {
    try {
        const admins = await apiCall('/api/admin/admins');

        document.getElementById('admins-table').innerHTML = `
            <table class="admin-table">
                <thead>
                    <tr>
                        <th>Email</th>
                        <th>Role</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${admins.map(a => `
                        <tr>
                            <td><strong>${a.email}</strong></td>
                            <td><span class="status-badge ${a.role === 'owner' ? 'completed' : 'paid'}">${a.role}</span></td>
                            <td>
                                ${!a.isOwner && adminRole === 'owner' ? `<button class="btn btn-small" onclick="removeAdmin('${a.user_id}')">Remove</button>` : ''}
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    } catch (err) {
        console.error('Admins load error:', err);
    }
}

function showAddAdminModal() {
    document.getElementById('admin-modal').classList.add('active');
}

function closeAdminModal() {
    document.getElementById('admin-modal').classList.remove('active');
}

async function addAdmin(event) {
    event.preventDefault();

    const email = document.getElementById('admin-email-input').value;
    const role = document.getElementById('admin-role-input').value;

    try {
        await apiCall('/api/admin/admins', {
            method: 'POST',
            body: JSON.stringify({ email, role })
        });

        alert('Admin added!');
        closeAdminModal();
        loadAdmins();
    } catch (err) {
        alert('Failed to add admin: ' + err.message);
    }
}

async function removeAdmin(userId) {
    if (!confirm('Are you sure you want to remove this admin?')) return;

    try {
        await apiCall(`/api/admin/admins/${userId}`, { method: 'DELETE' });
        loadAdmins();
    } catch (err) {
        alert('Failed to remove: ' + err.message);
    }
}

// =============================================================================
// UTILITIES
// =============================================================================

function formatStatus(status) {
    const labels = {
        pending: 'Pending',
        paid: 'Paid',
        printing: 'Printing',
        shipped: 'Shipped',
        ready_pickup: 'Ready for Pickup',
        completed: 'Completed',
        cancelled: 'Cancelled'
    };
    return labels[status] || status;
}

function formatDate(dateStr) {
    return new Date(dateStr).toLocaleDateString('en-AU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
    });
}
