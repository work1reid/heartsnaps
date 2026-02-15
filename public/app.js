// =============================================================================
// HEARTSNAPS - FRONTEND APPLICATION
// =============================================================================

let supabaseClient = null;
let stripe = null;
let currentUser = null;

// Order state
let orderState = {
    customerId: null,
    customerName: '',
    customerPhone: '',
    customerEmail: '',
    shippingType: 'delivery',
    shippingAddress: null,
    productType: 'personal',
    quantity: 6,
    photos: [],
    uploadedPhotos: [],
    isGift: false,
    giftMessage: '',
    notes: '',
    promoCode: null,
    promoDiscount: 0,
    orderId: null
};

// =============================================================================
// INITIALIZATION
// =============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    await initApp();
    setupEventListeners();
    loadGallery();
});

async function initApp() {
    try {
        // Fetch config
        const response = await fetch('/api/config');
        const config = await response.json();

        // Initialize Supabase
        supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);

        // Initialize Stripe
        stripe = Stripe(config.stripePublishableKey);

        // Check for existing session
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session) {
            currentUser = session.user;
            updateAuthUI();
        }

        // Listen for auth changes
        supabaseClient.auth.onAuthStateChange((event, session) => {
            currentUser = session?.user || null;
            updateAuthUI();
        });

        // Check URL params
        const params = new URLSearchParams(window.location.search);
        if (params.get('cancelled') === 'true') {
            const orderId = params.get('order');
            if (orderId) {
                orderState.orderId = orderId;
                alert('Payment was cancelled. You can try again.');
            }
        }

    } catch (err) {
        console.error('Init error:', err);
    }
}

function setupEventListeners() {
    // Details form submission
    document.getElementById('details-form').addEventListener('submit', (e) => {
        e.preventDefault();
        saveDetailsAndContinue();
    });

    // Drag and drop
    const uploadZone = document.getElementById('upload-zone');
    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.classList.add('drag-over');
    });
    uploadZone.addEventListener('dragleave', () => {
        uploadZone.classList.remove('drag-over');
    });
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('drag-over');
        handleFiles(e.dataTransfer.files);
    });
    uploadZone.addEventListener('click', () => {
        document.getElementById('file-input').click();
    });

    // Quantity input
    document.getElementById('quantity-input').addEventListener('input', updateQuantity);
}

// =============================================================================
// NAVIGATION
// =============================================================================

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
    window.scrollTo(0, 0);
}

function startOrder() {
    showScreen('order-flow');
    goToStep(1);
}

function goToStep(step) {
    // Update step indicators
    document.querySelectorAll('.progress-steps .step').forEach(s => {
        const stepNum = parseInt(s.dataset.step);
        s.classList.remove('active', 'completed');
        if (stepNum < step) s.classList.add('completed');
        if (stepNum === step) s.classList.add('active');
    });

    // Show correct step content
    document.querySelectorAll('.order-step').forEach(s => s.classList.remove('active'));
    document.querySelector(`.order-step[data-step="${step}"]`).classList.add('active');

    // Step-specific actions
    if (step === 3) {
        document.getElementById('upload-count').textContent = orderState.quantity;
        updateUploadUI();
    }

    if (step === 4) {
        updateReviewPage();
    }

    window.scrollTo(0, 0);
}

// =============================================================================
// STEP 1: CUSTOMER DETAILS
// =============================================================================

function toggleShippingFields() {
    const shippingType = document.querySelector('input[name="shipping-type"]:checked').value;
    const shippingFields = document.getElementById('shipping-fields');
    shippingFields.style.display = shippingType === 'delivery' ? 'block' : 'none';
    orderState.shippingType = shippingType;
    updatePriceSummary();
}

function saveDetailsAndContinue() {
    const name = document.getElementById('customer-name').value.trim();
    const phone = document.getElementById('customer-phone').value.trim();
    const email = document.getElementById('customer-email').value.trim();
    const shippingType = document.querySelector('input[name="shipping-type"]:checked').value;

    if (!name || !phone) {
        alert('Please fill in your name and phone number.');
        return;
    }

    if (shippingType === 'delivery') {
        const line1 = document.getElementById('address-line1').value.trim();
        const city = document.getElementById('address-city').value.trim();
        const state = document.getElementById('address-state').value;
        const postcode = document.getElementById('address-postcode').value.trim();

        if (!line1 || !city || !state || !postcode) {
            alert('Please fill in your delivery address.');
            return;
        }

        orderState.shippingAddress = {
            line1,
            line2: document.getElementById('address-line2').value.trim(),
            city,
            state,
            postcode
        };
    }

    orderState.customerName = name;
    orderState.customerPhone = phone;
    orderState.customerEmail = email;
    orderState.shippingType = shippingType;

    goToStep(2);
}

// =============================================================================
// STEP 2: PRODUCT SELECTION
// =============================================================================

function selectProductType(type) {
    orderState.productType = type;
    document.querySelectorAll('.product-card').forEach(card => {
        card.classList.remove('selected');
        if (card.querySelector('input').value === type) {
            card.classList.add('selected');
        }
    });
    updatePriceSummary();
}

function setQuantity(qty) {
    orderState.quantity = qty;
    document.getElementById('quantity-input').value = qty;
    document.querySelectorAll('.quantity-preset').forEach(btn => {
        btn.classList.remove('active');
        if (parseInt(btn.textContent) === qty) {
            btn.classList.add('active');
        }
    });
    updatePriceSummary();
}

function adjustQuantity(delta) {
    const input = document.getElementById('quantity-input');
    let qty = parseInt(input.value) + delta;
    if (qty < 1) qty = 1;
    if (qty > 100) qty = 100;
    input.value = qty;
    updateQuantity();
}

function updateQuantity() {
    const qty = parseInt(document.getElementById('quantity-input').value) || 1;
    orderState.quantity = qty;
    document.querySelectorAll('.quantity-preset').forEach(btn => btn.classList.remove('active'));
    updatePriceSummary();
}

function updatePriceSummary() {
    const qty = orderState.quantity;
    let pricePerUnit, tierLabel;

    if (qty >= 12) {
        pricePerUnit = 7;
        tierLabel = '$7 each (12-pack rate)';
    } else if (qty >= 6) {
        pricePerUnit = 8;
        tierLabel = '$8 each (6-pack rate)';
    } else {
        pricePerUnit = 10;
        tierLabel = '$10 each';
    }

    const subtotal = qty * pricePerUnit;
    const shipping = orderState.shippingType === 'pickup' ? 0 : 8;
    const total = subtotal + shipping;

    const summary = document.getElementById('price-summary');
    summary.innerHTML = `
        <div class="price-row">
            <span>${qty} magnets @ ${tierLabel}</span>
            <span>$${subtotal.toFixed(2)}</span>
        </div>
        <div class="price-row">
            <span>Shipping</span>
            <span id="shipping-cost">${shipping === 0 ? 'FREE' : '$' + shipping.toFixed(2)}</span>
        </div>
        <div class="price-row total">
            <span>Total</span>
            <span id="total-price">$${total.toFixed(2)}</span>
        </div>
    `;
}

// =============================================================================
// STEP 3: PHOTO UPLOAD
// =============================================================================

function handleFileSelect(event) {
    handleFiles(event.target.files);
}

function handleFiles(files) {
    const remaining = orderState.quantity - orderState.photos.length;

    if (remaining <= 0) {
        alert(`You've already added ${orderState.quantity} photos.`);
        return;
    }

    const filesToAdd = Array.from(files).slice(0, remaining);

    for (const file of filesToAdd) {
        if (!file.type.startsWith('image/')) {
            alert(`${file.name} is not an image file.`);
            continue;
        }

        if (file.size > 10 * 1024 * 1024) {
            alert(`${file.name} is too large. Maximum size is 10MB.`);
            continue;
        }

        orderState.photos.push(file);
    }

    updateUploadUI();
}

function updateUploadUI() {
    const container = document.getElementById('photo-previews');
    container.innerHTML = '';

    orderState.photos.forEach((file, index) => {
        const preview = document.createElement('div');
        preview.className = 'photo-preview';

        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-btn';
        removeBtn.innerHTML = '&times;';
        removeBtn.onclick = () => removePhoto(index);

        const number = document.createElement('div');
        number.className = 'photo-number';
        number.textContent = index + 1;

        preview.appendChild(img);
        preview.appendChild(removeBtn);
        preview.appendChild(number);
        container.appendChild(preview);
    });

    // Update continue button state
    const continueBtn = document.getElementById('continue-to-review');
    continueBtn.disabled = orderState.photos.length !== orderState.quantity;

    // Update instructions
    const remaining = orderState.quantity - orderState.photos.length;
    const instructions = document.querySelector('.upload-instructions');
    if (remaining > 0) {
        instructions.innerHTML = `Upload <strong>${remaining}</strong> more photo${remaining > 1 ? 's' : ''} (${orderState.photos.length}/${orderState.quantity})`;
    } else {
        instructions.innerHTML = `All <strong>${orderState.quantity}</strong> photos uploaded! Ready to continue.`;
    }
}

function removePhoto(index) {
    orderState.photos.splice(index, 1);
    updateUploadUI();
}

// =============================================================================
// STEP 4: REVIEW & CHECKOUT
// =============================================================================

function updateReviewPage() {
    // Update magnet previews
    const magnetsContainer = document.getElementById('review-magnets');
    magnetsContainer.innerHTML = '';
    orderState.photos.forEach((file, index) => {
        const div = document.createElement('div');
        div.className = 'review-magnet';
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        div.appendChild(img);
        magnetsContainer.appendChild(div);
    });

    // Update delivery details
    const detailsContainer = document.getElementById('review-details');
    let addressHTML = '';
    if (orderState.shippingType === 'delivery') {
        addressHTML = `
            <p><strong>${orderState.customerName}</strong></p>
            <p>${orderState.shippingAddress.line1}</p>
            ${orderState.shippingAddress.line2 ? `<p>${orderState.shippingAddress.line2}</p>` : ''}
            <p>${orderState.shippingAddress.city}, ${orderState.shippingAddress.state} ${orderState.shippingAddress.postcode}</p>
            <p>Phone: ${orderState.customerPhone}</p>
            ${orderState.customerEmail ? `<p>Email: ${orderState.customerEmail}</p>` : ''}
        `;
    } else {
        addressHTML = `
            <p><strong>${orderState.customerName}</strong></p>
            <p>Pickup in Forbes, NSW</p>
            <p>Phone: ${orderState.customerPhone}</p>
            ${orderState.customerEmail ? `<p>Email: ${orderState.customerEmail}</p>` : ''}
        `;
    }
    detailsContainer.innerHTML = addressHTML;

    // Update order summary
    updateOrderSummary();
}

function toggleGiftFields() {
    const isGift = document.getElementById('is-gift').checked;
    document.getElementById('gift-fields').style.display = isGift ? 'block' : 'none';
    orderState.isGift = isGift;
}

async function applyPromoCode() {
    const code = document.getElementById('promo-code').value.trim();
    const messageEl = document.getElementById('promo-message');

    if (!code) {
        messageEl.textContent = '';
        messageEl.className = 'promo-message';
        return;
    }

    try {
        const subtotal = calculateSubtotal();
        const response = await fetch('/api/validate-promo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, subtotal: subtotal * 100 })
        });

        const data = await response.json();

        if (response.ok && data.valid) {
            orderState.promoCode = data.code;
            orderState.promoDiscount = data.calculatedDiscount / 100;
            messageEl.textContent = `Code applied! ${data.discountType === 'percentage' ? data.discountValue + '% off' : '$' + (data.discountValue / 100).toFixed(2) + ' off'}`;
            messageEl.className = 'promo-message success';
            updateOrderSummary();
        } else {
            orderState.promoCode = null;
            orderState.promoDiscount = 0;
            messageEl.textContent = data.error || 'Invalid promo code';
            messageEl.className = 'promo-message error';
            updateOrderSummary();
        }
    } catch (err) {
        console.error('Promo error:', err);
        messageEl.textContent = 'Failed to validate promo code';
        messageEl.className = 'promo-message error';
    }
}

function calculateSubtotal() {
    const qty = orderState.quantity;
    if (qty >= 12) return qty * 7;
    if (qty >= 6) return qty * 8;
    return qty * 10;
}

function updateOrderSummary() {
    const subtotal = calculateSubtotal();
    const shipping = orderState.shippingType === 'pickup' ? 0 : 8;
    const discount = orderState.promoDiscount;
    const total = subtotal + shipping - discount;

    document.getElementById('summary-subtotal').textContent = `$${subtotal.toFixed(2)}`;
    document.getElementById('summary-shipping').textContent = shipping === 0 ? 'FREE' : `$${shipping.toFixed(2)}`;

    const discountRow = document.getElementById('discount-row');
    if (discount > 0) {
        discountRow.style.display = 'flex';
        document.getElementById('summary-discount').textContent = `-$${discount.toFixed(2)}`;
    } else {
        discountRow.style.display = 'none';
    }

    document.getElementById('summary-total').textContent = `$${total.toFixed(2)}`;
}

async function proceedToCheckout() {
    const checkoutBtn = document.getElementById('checkout-btn');
    checkoutBtn.disabled = true;
    checkoutBtn.textContent = 'Processing...';

    try {
        // Get gift message and notes
        orderState.giftMessage = document.getElementById('gift-message')?.value || '';
        orderState.notes = document.getElementById('order-notes')?.value || '';

        // Create order first
        const orderResponse = await fetch('/api/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customerName: orderState.customerName,
                customerPhone: orderState.customerPhone,
                customerEmail: orderState.customerEmail,
                shippingType: orderState.shippingType,
                shippingAddress: orderState.shippingAddress,
                productType: orderState.productType,
                quantity: orderState.quantity,
                isGift: orderState.isGift,
                giftMessage: orderState.giftMessage,
                notes: orderState.notes,
                promoCode: orderState.promoCode
            })
        });

        const orderData = await orderResponse.json();

        if (!orderResponse.ok) {
            throw new Error(orderData.error || 'Failed to create order');
        }

        orderState.orderId = orderData.orderId;

        // Upload photos
        checkoutBtn.textContent = 'Uploading photos...';

        for (let i = 0; i < orderState.photos.length; i++) {
            const formData = new FormData();
            formData.append('file', orderState.photos[i]);
            formData.append('orderId', orderState.orderId);
            formData.append('position', i);

            await fetch('/api/upload-photo', {
                method: 'POST',
                body: formData
            });
        }

        // Create checkout session
        checkoutBtn.textContent = 'Redirecting to payment...';

        const checkoutResponse = await fetch('/api/create-checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: orderState.orderId })
        });

        const checkoutData = await checkoutResponse.json();

        if (!checkoutResponse.ok) {
            throw new Error(checkoutData.error || 'Failed to create checkout');
        }

        // Redirect to Stripe
        window.location.href = checkoutData.url;

    } catch (err) {
        console.error('Checkout error:', err);
        alert('Something went wrong: ' + err.message);
        checkoutBtn.disabled = false;
        checkoutBtn.textContent = 'Proceed to Payment';
    }
}

// =============================================================================
// AUTHENTICATION
// =============================================================================

function showAuthModal() {
    document.getElementById('auth-modal').classList.add('active');
}

function closeAuthModal() {
    document.getElementById('auth-modal').classList.remove('active');
}

async function signInWithGoogle() {
    const { error } = await supabaseClient.auth.signInWithOAuth({
        provider: 'google',
        options: {
            redirectTo: window.location.origin
        }
    });

    if (error) {
        console.error('Sign in error:', error);
        alert('Sign in failed: ' + error.message);
    }
}

function updateAuthUI() {
    const navBtn = document.querySelector('.nav .btn');
    if (currentUser) {
        navBtn.textContent = 'Account';
        navBtn.onclick = () => {
            // Could show account menu
            if (confirm('Sign out?')) {
                supabaseClient.auth.signOut();
            }
        };
    } else {
        navBtn.textContent = 'Sign In';
        navBtn.onclick = showAuthModal;
    }
}

// =============================================================================
// CUSTOMER LOOKUP
// =============================================================================

function showLookupModal() {
    document.getElementById('lookup-modal').classList.add('active');
}

function closeLookupModal() {
    document.getElementById('lookup-modal').classList.remove('active');
}

async function lookupCustomer(event) {
    event.preventDefault();

    const input = document.getElementById('lookup-input').value.trim();
    const resultEl = document.getElementById('lookup-result');

    if (!input) {
        resultEl.textContent = 'Please enter your phone or email.';
        return;
    }

    try {
        const isEmail = input.includes('@');
        const response = await fetch('/api/customer/lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(isEmail ? { email: input } : { phone: input })
        });

        const data = await response.json();

        if (response.ok && data.customer) {
            // Fill in the form
            document.getElementById('customer-name').value = data.customer.name || '';
            document.getElementById('customer-phone').value = data.customer.phone || '';
            document.getElementById('customer-email').value = data.customer.email || '';

            if (data.customer.address) {
                document.getElementById('address-line1').value = data.customer.address.line1 || '';
                document.getElementById('address-line2').value = data.customer.address.line2 || '';
                document.getElementById('address-city').value = data.customer.address.city || '';
                document.getElementById('address-state').value = data.customer.address.state || '';
                document.getElementById('address-postcode').value = data.customer.address.postcode || '';
            }

            resultEl.innerHTML = `<strong>Found!</strong> Your details have been filled in.`;
            setTimeout(closeLookupModal, 1500);
        } else {
            resultEl.textContent = data.error || 'No customer found with that info.';
        }
    } catch (err) {
        console.error('Lookup error:', err);
        resultEl.textContent = 'Lookup failed. Please try again.';
    }
}

// =============================================================================
// GALLERY
// =============================================================================

async function loadGallery() {
    try {
        const response = await fetch('/api/gallery');
        const items = await response.json();

        if (items && items.length > 0) {
            const grid = document.getElementById('gallery-grid');
            grid.innerHTML = '';

            items.forEach(item => {
                const div = document.createElement('div');
                div.className = 'gallery-item';
                const img = document.createElement('img');
                img.src = item.imageUrl;
                img.alt = item.caption || 'Magnet example';
                div.appendChild(img);
                grid.appendChild(div);
            });
        }
    } catch (err) {
        console.error('Gallery load error:', err);
        // Keep placeholder images on error
    }
}

// Initialize price summary on load
updatePriceSummary();
