const BASE_URL = 'https://www.aldi.com.au';

/**
 * Deterministic positive 32-bit FNV-1a hash fallback when an ALDI SKU has no digits.
 */
function hashToPositiveInt(input) {
    let hash = 0x811c9dc5;
    const str = String(input);
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    const unsigned = hash >>> 0;
    return unsigned === 0 ? 1 : unsigned;
}

/**
 * Convert an ALDI SKU (e.g. "000000000000385792", "385792", or alphanumeric)
 * into a positive integer compatible with Supabase `products.stockcode` (BIGINT).
 */
export function parseStockcode(rawSku) {
    if (typeof rawSku === 'number' && Number.isFinite(rawSku) && rawSku > 0) {
        return Math.trunc(rawSku);
    }
    if (rawSku == null) return null;
    const trimmed = String(rawSku).trim();
    if (!trimmed) return null;

    const digitsOnly = trimmed.replace(/\D/g, '');
    if (digitsOnly.length > 0) {
        const parsed = Number.parseInt(digitsOnly, 10);
        if (Number.isSafeInteger(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return hashToPositiveInt(trimmed);
}

/**
 * Parse a dollar amount from a display string like "$4.99" or "4.99".
 */
export function parseDollarString(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return null;
    const match = value.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
    if (!match) return null;
    const n = Number.parseFloat(match[1]);
    return Number.isFinite(n) ? n : null;
}

/**
 * Convert an ALDI integer-cents value (e.g. 499 -> 4.99) to dollars.
 */
function centsToDollars(cents) {
    if (typeof cents !== 'number' || !Number.isFinite(cents)) return null;
    return Math.round(cents) / 100;
}

/**
 * Parse unit price info from ALDI's `price.comparisonDisplay` (e.g. "$1.55 per 1L", "$0.75 / 100g").
 */
export function parseCupString(cupString, comparisonCents = null) {
    const clean = typeof cupString === 'string' && cupString.trim() ? cupString.trim() : null;
    let cupPrice = centsToDollars(comparisonCents);
    let cupMeasure = null;

    if (clean) {
        if (cupPrice == null) {
            cupPrice = parseDollarString(clean);
        }
        const measureMatch = clean.match(/(?:per|\/)\s*([0-9.]*\s*[a-zA-Z]+)/i);
        if (measureMatch) {
            cupMeasure = measureMatch[1].trim();
        }
    }

    return {
        cupPrice,
        cupMeasure,
        cupString: clean,
    };
}

/**
 * Resolve ALDI CDN image template URLs (which may contain `{width}` and `{slug}` placeholders).
 */
export function resolveImageUrl(product) {
    const firstAsset = Array.isArray(product.assets) ? product.assets[0] : null;
    let rawUrl = firstAsset?.url || product.imageUrl || product.image || null;
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;

    rawUrl = rawUrl.trim();
    const slug = product.urlSlugText || 'product';
    rawUrl = rawUrl
        .replace(/\{width\}/gi, '500')
        .replace(/\{slug\}/gi, slug);

    if (rawUrl.startsWith('//')) return `https:${rawUrl}`;
    if (rawUrl.startsWith('/')) return `${BASE_URL}${rawUrl}`;
    return rawUrl;
}

/**
 * Build canonical ALDI Australia product URL.
 */
export function resolveProductUrl(product) {
    const raw = product.productUrl || product.url || null;
    if (typeof raw === 'string' && raw.trim()) {
        const trimmed = raw.trim();
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
        return `${BASE_URL}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
    }
    if (product.urlSlugText && product.sku) {
        return `${BASE_URL}/product/${product.urlSlugText}-${product.sku}`;
    }
    if (product.sku) {
        return `${BASE_URL}/product/${product.sku}`;
    }
    return null;
}

/**
 * Normalize an ALDI Australia v3/v2 product object into the shared Papa PriceChecker dataset schema.
 */
export function normalizeProduct(product, { source, region = 'au', scrapedAt = new Date().toISOString() } = {}) {
    if (!product || typeof product !== 'object') return null;

    const rawSku = product.sku ?? product.productId ?? product.id;
    const stockcode = parseStockcode(rawSku);
    const name = typeof product.name === 'string' ? product.name.trim() : null;
    if (!stockcode || !name) return null;

    const priceObj = product.price && typeof product.price === 'object' ? product.price : null;

    const price = priceObj
        ? (centsToDollars(priceObj.amountRelevant)
            ?? centsToDollars(priceObj.amount)
            ?? parseDollarString(priceObj.amountRelevantDisplay)
            ?? parseDollarString(priceObj.amountDisplay))
        : parseDollarString(product.price);

    const rawWasPrice = priceObj
        ? (centsToDollars(priceObj.wasPrice)
            ?? centsToDollars(priceObj.strikeThroughAmount)
            ?? parseDollarString(priceObj.wasPriceDisplay)
            ?? parseDollarString(priceObj.strikeThroughPrice))
        : parseDollarString(product.wasPrice);

    const wasPrice = rawWasPrice != null && price != null && rawWasPrice > price ? rawWasPrice : null;

    const savingsAmount = wasPrice != null && price != null
        ? Math.round((wasPrice - price) * 100) / 100
        : (priceObj ? parseDollarString(priceObj.reduction) : null);

    const badges = Array.isArray(product.badges) ? product.badges : [];
    const badgeTexts = badges
        .map((b) => (typeof b === 'string' ? b : b?.text || b?.label || b?.name || null))
        .filter(Boolean);

    const isOnSpecial = Boolean(
        product.isSpecial
        || product.onSale
        || (wasPrice != null && price != null && wasPrice > price)
        || badgeTexts.some((t) => /special|save|lower|reduced|sale/i.test(t)),
    );

    const isHalfPrice = Boolean(
        wasPrice != null && price != null && wasPrice > 0 && price <= wasPrice * 0.505,
    );

    const promotion = badgeTexts.length > 0
        ? badgeTexts.join(' · ')
        : (priceObj?.additionalInfo || product.savingsText || null);

    const isMultibuy = Boolean(
        promotion && /\b(\d+\s+for\s+\$|buy\s+\d+|multi)/i.test(promotion),
    );

    const categories = Array.isArray(product.categories) ? product.categories : [];
    const departments = categories
        .map((c) => (typeof c === 'string' ? c : c?.name))
        .filter((s) => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.trim());

    const category = departments.length > 0
        ? departments[departments.length - 1]
        : (typeof product.category === 'string' ? product.category.trim() : null);

    const { cupPrice, cupMeasure, cupString } = parseCupString(
        priceObj?.comparisonDisplay ?? product.cupString ?? null,
        priceObj?.comparison ?? null,
    );

    const packageSize = (
        product.sellingSize
        || product.packSize
        || product.netContent
        || product.packageSize
        || null
    );

    const brand = (
        (typeof product.brandName === 'string' && product.brandName.trim())
        || (typeof product.brand === 'string' && product.brand.trim())
        || null
    );

    // ALDI AU is walk-in only (no online cart), so their API sets `notForSale: true`
    // on regular in-store products; default to true unless `isAvailable` is explicitly false.
    const isAvailable = typeof product.isAvailable === 'boolean' ? product.isAvailable : true;

    return {
        chain: 'aldi',
        stockcode,
        name,
        brand,
        packageSize: typeof packageSize === 'string' ? packageSize.trim() || null : null,
        price,
        wasPrice,
        savingsAmount: savingsAmount && savingsAmount > 0 ? savingsAmount : null,
        isOnSpecial,
        isHalfPrice,
        promotion: typeof promotion === 'string' ? promotion.trim() || null : null,
        isMultibuy,
        departments,
        category,
        productLimit: typeof product.maxOrderQuantity === 'number' ? product.maxOrderQuantity : null,
        cupPrice,
        cupMeasure,
        cupString,
        isAvailable,
        url: resolveProductUrl(product),
        imageUrl: resolveImageUrl(product),
        source: source || null,
        region: region || null,
        scrapedAt,
    };
}
