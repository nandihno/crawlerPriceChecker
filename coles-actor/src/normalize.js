const BASE_URL = 'https://www.coles.com.au';
const IMAGE_CDN_BASE = 'https://cdn.productimages.coles.com.au/productimages';

/**
 * Convert a Coles product ID (e.g. 422493 or "422493") into a positive integer
 * compatible with Supabase `products.stockcode` (BIGINT).
 */
export function parseStockcode(rawId) {
    if (typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0) {
        return rawId;
    }
    if (rawId == null) return null;
    const digits = String(rawId).replace(/\D/g, '');
    if (!digits) return null;
    const parsed = Number.parseInt(digits, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Parse a dollar amount from a number or string like "$3.10".
 */
export function parseDollar(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return null;
    const match = value.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
    if (!match) return null;
    const n = Number.parseFloat(match[1]);
    return Number.isFinite(n) ? n : null;
}

/**
 * Parse Coles unit pricing (`pricing.comparable` like "$1.55 / 1L" and `pricing.unit`).
 */
export function parseUnitPricing(pricing) {
    const comparable = typeof pricing?.comparable === 'string' && pricing.comparable.trim()
        ? pricing.comparable.trim()
        : null;
    const unit = pricing?.unit && typeof pricing.unit === 'object' ? pricing.unit : null;

    let cupPrice = parseDollar(unit?.price ?? unit?.cupPrice ?? null);
    let cupMeasure = null;

    if (unit?.cupMeasure) {
        cupMeasure = String(unit.cupMeasure).trim();
    } else if (unit?.ofMeasureUnits) {
        const qty = unit.ofMeasureQuantity ? `${unit.ofMeasureQuantity}` : '';
        cupMeasure = `${qty}${unit.ofMeasureUnits}`.trim();
    } else if (unit?.ofMeasurement) {
        const qty = unit.quantity ? `${unit.quantity}` : '';
        cupMeasure = `${qty}${unit.ofMeasurement}`.trim();
    }

    if (comparable) {
        if (cupPrice == null) cupPrice = parseDollar(comparable);
        if (!cupMeasure) {
            const m = comparable.match(/(?:\/|per)\s*([0-9.]*\s*[a-zA-Z]+)/i);
            if (m) cupMeasure = m[1].trim();
        }
    }

    return {
        cupPrice,
        cupMeasure: cupMeasure || null,
        cupString: comparable,
    };
}

/**
 * Resolve Coles product image URL from `imageUris`.
 */
export function resolveImageUrl(product) {
    const first = Array.isArray(product.imageUris) ? product.imageUris[0] : null;
    const raw = first?.uri || first?.large || first?.thumbnail || product.imageUrl || null;
    if (typeof raw !== 'string' || !raw.trim()) return null;

    const trimmed = raw.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
    if (trimmed.startsWith('//')) return `https:${trimmed}`;
    return `${IMAGE_CDN_BASE}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
}

/**
 * Build canonical Coles product URL.
 */
export function resolveProductUrl(product, stockcode) {
    const raw = product.url || product.productUrl || null;
    if (typeof raw === 'string' && raw.trim()) {
        const trimmed = raw.trim();
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
        return `${BASE_URL}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
    }
    const slugSource = [product.brand, product.name, product.size]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (slugSource && stockcode) {
        return `${BASE_URL}/product/${slugSource}-${stockcode}`;
    }
    return stockcode ? `${BASE_URL}/product/${stockcode}` : null;
}

/**
 * Extract product items from Coles Next.js search response (`pageProps.searchResults.results`, etc.).
 */
export function extractSearchResults(payload) {
    if (!payload || typeof payload !== 'object') return { items: [], total: 0, pageSize: 48 };
    const pageProps = payload.pageProps ?? payload.props?.pageProps ?? payload;
    const searchResults = pageProps?.searchResults
        ?? pageProps?.initialState?.products
        ?? pageProps;

    const rawResults = Array.isArray(searchResults?.results) ? searchResults.results : [];
    const items = rawResults.filter((r) => r && typeof r === 'object' && (!r._type || r._type === 'PRODUCT'));
    const total = searchResults?.noOfResults ?? searchResults?.totalCount ?? items.length;
    const pageSize = searchResults?.pageSize ?? 48;
    return { items, total, pageSize };
}

/**
 * Normalize a Coles Australia product object into the shared Papa PriceChecker dataset schema.
 */
export function normalizeProduct(product, { source, region = 'au', scrapedAt = new Date().toISOString() } = {}) {
    if (!product || typeof product !== 'object') return null;

    const stockcode = parseStockcode(product.id ?? product.stockcode);
    const rawName = typeof product.name === 'string' ? product.name.trim() : '';
    const brand = typeof product.brand === 'string' && product.brand.trim() ? product.brand.trim() : null;
    const size = typeof product.size === 'string' && product.size.trim()
        ? product.size.trim()
        : (typeof product.packageSize === 'string' && product.packageSize.trim() ? product.packageSize.trim() : null);

    // Coles often puts brand separately from name; keep name clean and informative
    const name = rawName
        ? (brand && !rawName.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${rawName}` : rawName)
        : null;

    if (!stockcode || !name) return null;

    const pricing = product.pricing && typeof product.pricing === 'object' ? product.pricing : {};
    const price = parseDollar(pricing.now ?? product.price);
    const rawWas = parseDollar(pricing.was ?? product.wasPrice);
    const wasPrice = rawWas != null && price != null && rawWas > price ? rawWas : null;

    const rawSavings = parseDollar(pricing.saveAmount);
    const savingsAmount = rawSavings && rawSavings > 0
        ? Math.round(rawSavings * 100) / 100
        : (wasPrice != null && price != null ? Math.round((wasPrice - price) * 100) / 100 : null);

    const promoType = String(pricing.promotionType || '').toUpperCase();
    const promoDescription = pricing.saveStatement
        || pricing.offerDescription
        || pricing.multiBuyPromotion?.offerDescription
        || (Array.isArray(product.promotions) && product.promotions[0]?.description)
        || null;

    const isMultibuy = Boolean(
        pricing.multiBuyPromotion
        || promoType === 'MULTI_BUY'
        || (promoDescription && /\b(\d+\s+for\s+\$|buy\s+\d+|multi)/i.test(promoDescription)),
    );

    const isOnSpecial = Boolean(
        promoType === 'SPECIAL'
        || promoType === 'HALF_PRICE'
        || (wasPrice != null && price != null && wasPrice > price)
        || isMultibuy,
    );

    const isHalfPrice = Boolean(
        promoType === 'HALF_PRICE'
        || (typeof pricing.savePercent === 'number' && pricing.savePercent >= 50)
        || (wasPrice != null && price != null && wasPrice > 0 && price <= wasPrice * 0.505)
        || (promoDescription && /half\s*price|50%\s*off/i.test(promoDescription)),
    );

    const heir = (Array.isArray(product.onlineHeirs) && product.onlineHeirs[0])
        || product.merchandiseHeirs
        || null;
    const departments = heir
        ? [heir.aisle, heir.category, heir.subCategory]
            .filter((s) => typeof s === 'string' && s.trim().length > 0)
            .map((s) => s.trim())
        : [];
    const category = departments.length > 0 ? departments[departments.length - 1] : null;

    const { cupPrice, cupMeasure, cupString } = parseUnitPricing(pricing);

    const isAvailable = typeof product.availability === 'boolean'
        ? product.availability
        : (typeof product.onlineAvailability === 'boolean' ? product.onlineAvailability : true);

    const productLimit = typeof product.restrictions?.retailLimit === 'number'
        ? product.restrictions.retailLimit
        : null;

    return {
        chain: 'coles',
        stockcode,
        name,
        brand,
        packageSize: size,
        price,
        wasPrice,
        savingsAmount,
        isOnSpecial,
        isHalfPrice,
        promotion: typeof promoDescription === 'string' ? promoDescription.trim() || null : null,
        isMultibuy,
        departments,
        category,
        productLimit,
        cupPrice,
        cupMeasure,
        cupString,
        isAvailable,
        url: resolveProductUrl(product, stockcode),
        imageUrl: resolveImageUrl(product),
        source: source || null,
        region: region || null,
        scrapedAt,
    };
}
