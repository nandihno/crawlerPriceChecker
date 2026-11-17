// Woolworths AU Prices — Apify actor
//
// Strategy: open one real browser session on woolworths.com.au so Akamai issues
// its cookies (_abck, bm_sv, ak_bmsc) and the site sets its own auth cookies,
// then call the site's JSON API *from inside that page* with fetch(). The
// requests carry the browser's real cookies and TLS fingerprint, so there is
// no cookie copying and no HTML parsing.

import { Actor, log } from 'apify';
import { chromium } from 'playwright';

const BASE = 'https://www.woolworths.com.au';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const {
    searchTerms = [],
    stockcodes = [],
    maxItemsPerSearch = 72,
    sortType = 'TraderRelevance',
    specialsOnly = false,
    delayMs = 1500,
    proxyConfiguration: proxyInput,
} = (await Actor.getInput()) ?? {};

if (!searchTerms.length && !stockcodes.length) {
    throw new Error('Provide at least one search term or stockcode.');
}

// ---------- browser session ----------------------------------------------

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
log.info(`Proxy: ${proxyConfiguration ? JSON.stringify(proxyInput) : 'none'}`);

let sessionCounter = 0;
// Woolworths picks a default store/region from the IP; anonymous visitors cannot choose one.
let region = null;

/**
 * Poll until Akamai's _abck cookie is present and validated (its value
 * contains "~0~" once the sensor data has been accepted).
 */
async function waitForBotCookie(context, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const abck = (await context.cookies(BASE)).find((c) => c.name === '_abck');
        if (abck?.value.includes('~0~')) return true;
        await sleep(1000);
    }
    log.warning('_abck cookie not validated in time; continuing anyway.');
    return false;
}

async function launchSessionOnce() {
    let proxy;
    if (proxyConfiguration) {
        // A fixed sessionId pins one exit IP for the whole browser session;
        // Akamai's cookies are bound to the IP they were issued to.
        const u = new URL(await proxyConfiguration.newUrl(`woolies_${Date.now()}_${sessionCounter++}`));
        proxy = {
            server: `${u.protocol}//${u.host}`,
            username: decodeURIComponent(u.username),
            password: decodeURIComponent(u.password),
        };
    }
    const browser = await chromium.launch({
        // Headed under Xvfb (the Apify image provides it) is far less detectable.
        headless: !Actor.isAtHome(),
        proxy,
        // The Apify image ships full Google Chrome, not Playwright's bundled
        // headless shell. Real Chrome also gives a more genuine fingerprint.
        ...(Actor.isAtHome() ? { channel: 'chrome' } : {}),
    });
    const context = await browser.newContext({
        locale: 'en-AU',
        timezoneId: 'Australia/Melbourne',
        viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();
    // Skip heavy assets; we only need the scripts that set cookies.
    await page.route('**/*.{png,jpg,jpeg,webp,gif,svg,woff,woff2,mp4}', (r) => r.abort());

    try {
        log.info('Bootstrapping session on woolworths.com.au ...');
        await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 40_000 });
        await waitForBotCookie(context);
        region = (await context.cookies(BASE)).find((c) => c.name === 'bff_region')?.value ?? null;
        return { browser, page };
    } catch (err) {
        await browser.close().catch(() => {});
        throw err;
    }
}

/** Launch a session, retrying on a fresh proxy IP if the bootstrap fails. */
async function launchSession(maxAttempts = 4) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await launchSessionOnce();
        } catch (err) {
            log.warning(`Session bootstrap failed (attempt ${attempt}/${maxAttempts}): ${err.message.split('\n')[0]}`);
            if (attempt >= maxAttempts) throw err;
            await sleep(2000 * attempt);
        }
    }
}

let session = await launchSession();

/** Run fetch() inside the page so the site's own cookies are used. */
async function apiCall(path, { method = 'GET', body } = {}, attempt = 1) {
    let res;
    try {
        res = await session.page.evaluate(
            async ({ path, method, body }) => {
                const r = await fetch(path, {
                    method,
                    credentials: 'include',
                    headers: {
                        accept: 'application/json, text/plain, */*',
                        ...(body ? { 'content-type': 'application/json' } : {}),
                    },
                    body: body ? JSON.stringify(body) : undefined,
                });
                const text = await r.text();
                let json = null;
                try { json = JSON.parse(text); } catch { /* not JSON = probably a block page */ }
                return { status: r.status, json, snippet: json ? null : text.slice(0, 200) };
            },
            { path, method, body },
        );
    } catch (err) {
        res = { status: 0, json: null, snippet: `evaluate failed: ${err.message}` };
    }

    if (res.status === 200 && res.json) return res.json;

    log.warning(`${method} ${path} -> ${res.status} (attempt ${attempt}) ${res.snippet ?? ''}`);
    if (attempt >= 3 || res.status === 404) return null;

    // 403/429 or a non-JSON page: back off, then start a fresh session (new proxy IP).
    await sleep(5000 * attempt);
    await session.browser.close().catch(() => {});
    session = await launchSession();
    return apiCall(path, { method, body }, attempt + 1);
}

// ---------- normalising --------------------------------------------------

// Search results come back as Products: [ { Products: [ ...variants ] }, ... ]
// in practice, but be defensive in case the list is flat.
function flattenProducts(json) {
    const list = json?.Products ?? [];
    return list.flatMap((item) => (Array.isArray(item?.Products) ? item.Products : [item]));
}

/** Remove HTML comments/tags and collapse whitespace; null if nothing left. */
const stripHtml = (v) =>
    typeof v === 'string'
        ? v.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || null
        : null;

/** Parse a JSON-encoded string array (or pass an array through). */
const parseList = (v) => {
    if (Array.isArray(v)) return v;
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : null; } catch { return null; }
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function toRow(p, source) {
    // The detail endpoint sometimes reports 0 for Price; a zero price is bad data, not a bargain.
    const rawPrice = num(p.Price) || num(p.InstorePrice);
    const price = rawPrice !== null && rawPrice > 0 ? rawPrice : null;
    // Woolworths often sends WasPrice === Price when nothing is on special.
    const rawWas = num(p.WasPrice);
    const wasPrice = price !== null && rawWas !== null && rawWas > price ? rawWas : null;
    return {
        chain: 'woolworths',
        stockcode: p.Stockcode ?? null,
        barcode: p.Barcode ?? null,
        name: p.DisplayName ?? p.Name ?? null,
        brand: p.Brand ?? null,
        packageSize: p.PackageSize ?? null,
        price,
        wasPrice,
        savingsAmount: num(p.SavingsAmount) || (wasPrice !== null ? +(wasPrice - price).toFixed(2) : null),
        isOnSpecial: Boolean(p.IsOnSpecial),
        isHalfPrice: Boolean(p.IsHalfPrice),
        promotion: stripHtml(p.PromotionDescription ?? p.CentreTag?.TagContent),
        isMultibuy: Boolean(p.Promotion?.IsMultiBuy ?? p.IsMultiBuy),
        departments: parseList(p.AdditionalAttributes?.piesdepartmentnamesjson) ?? (p.Department ? [p.Department] : null),
        category: p.Category ?? null,
        productLimit: num(p.ProductLimit),
        cupPrice: p.CupPrice ?? null,
        cupMeasure: p.CupMeasure ?? null,
        cupString: p.CupString ?? null,
        isAvailable: p.IsAvailable ?? null,
        url: p.Stockcode ? `${BASE}/shop/productdetails/${p.Stockcode}/${p.UrlFriendlyName ?? ''}` : null,
        imageUrl: p.LargeImageFile ?? p.ImageUris?.large ?? null,
        source,
        region,
        scrapedAt: new Date().toISOString(),
    };
}

try {
    // ---------- search -------------------------------------------------------

    const PAGE_SIZE = 36;
    let totalRows = 0;
    const failed = [];

    for (const term of searchTerms) {
        const seen = new Set();
        let pageNumber = 1;
        let totalPages = Infinity;

        while (seen.size < maxItemsPerSearch && pageNumber <= totalPages) {
            const json = await apiCall('/apis/ui/Search/products', {
                method: 'POST',
                body: {
                    searchTerm: term,
                    pageNumber,
                    pageSize: PAGE_SIZE,
                    sortType,
                    location: `/shop/search/products?searchTerm=${encodeURIComponent(term)}`,
                    formatObject: JSON.stringify({ name: term }),
                    isSpecial: specialsOnly,
                    isBundle: false,
                    isMobile: false,
                    filters: [],
                    groupEdmVariants: false,
                },
            });
            if (!json) { failed.push(`search:${term} (page ${pageNumber})`); break; }

            if (json.Pagination?.TotalPages) totalPages = json.Pagination.TotalPages;
            else if (json.SearchResultsCount) totalPages = Math.ceil(json.SearchResultsCount / PAGE_SIZE);

            const rows = flattenProducts(json)
                .filter((p) => p?.Stockcode && !seen.has(p.Stockcode))
                .slice(0, maxItemsPerSearch - seen.size)
                .map((p) => { seen.add(p.Stockcode); return toRow(p, `search:${term}`); });

            if (!rows.length) {
                if (pageNumber === 1) failed.push(`search:${term} (no results)`);
                break;
            }
            await Actor.pushData(rows);
            totalRows += rows.length;
            log.info(`"${term}" page ${pageNumber}: +${rows.length} (total ${seen.size})`);

            pageNumber += 1;
            await sleep(delayMs);
        }
    }

    // ---------- watchlist by stockcode --------------------------------------
    // NOTE: this detail endpoint is not in the published notes. Confirm it in
    // DevTools (open any product page, filter Network by "detail") on first run.

    for (const code of stockcodes) {
        const json = await apiCall(`/apis/ui/product/detail/${encodeURIComponent(code)}`);
        const p = json?.Product ?? json;
        if (p?.Stockcode) { await Actor.pushData(toRow(p, `stockcode:${code}`)); totalRows += 1; }
        else { log.warning(`No product data for stockcode ${code}`); failed.push(`stockcode:${code}`); }
        await sleep(delayMs);
    }

    if (failed.length) log.warning(`Incomplete: ${failed.join(', ')}`);
    if (totalRows === 0) {
        throw new Error('No products were collected (likely blocked). Try a RESIDENTIAL AU proxy.');
    }
    log.info(`Done: ${totalRows} rows, ${failed.length} failed item(s).`);
} finally {
    await session.browser.close().catch(() => {});
}

await Actor.exit();
