import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSearchResults, normalizeProduct, parseStockcode } from '../src/normalize.js';

test('parseStockcode extracts positive integer Coles product IDs', () => {
    assert.equal(parseStockcode(422493), 422493);
    assert.equal(parseStockcode('422493'), 422493);
    assert.equal(parseStockcode(''), null);
    assert.equal(parseStockcode(null), null);
});

test('extractSearchResults filters PRODUCT items from Next.js pageProps', () => {
    const payload = {
        pageProps: {
            searchResults: {
                noOfResults: 2,
                pageSize: 48,
                results: [
                    { _type: 'SINGLE_TILE', id: 1 },
                    { _type: 'PRODUCT', id: 422493, name: 'Full Cream Milk' },
                    { _type: 'PRODUCT', id: 422494, name: 'Skim Milk' },
                ],
            },
        },
    };
    const { items, total, pageSize } = extractSearchResults(payload);
    assert.equal(items.length, 2);
    assert.equal(total, 2);
    assert.equal(pageSize, 48);
});

test('normalizeProduct maps Coles Next.js payload to Supabase ingest-apify-run schema', () => {
    const sample = {
        _type: 'PRODUCT',
        id: 422493,
        name: 'Full Cream Milk',
        brand: 'Coles',
        size: '2L',
        availability: true,
        imageUris: [{ uri: '/4/422493.jpg' }],
        onlineHeirs: [
            { aisle: 'Dairy, Eggs & Fridge', category: 'Milk', subCategory: 'Full Cream Milk' },
        ],
        pricing: {
            now: 3.1,
            was: 3.5,
            saveAmount: 0.4,
            saveStatement: 'Save $0.40',
            promotionType: 'SPECIAL',
            comparable: '$1.55 / 1L',
            unit: {
                price: 1.55,
                ofMeasureQuantity: 1,
                ofMeasureUnits: 'L',
            },
        },
        restrictions: {
            retailLimit: 20,
        },
    };

    const result = normalizeProduct(sample, {
        source: 'search:milk',
        region: 'syd1',
        scrapedAt: '2026-11-20T00:00:00.000Z',
    });

    assert.equal(result.chain, 'coles');
    assert.equal(result.stockcode, 422493);
    assert.equal(result.name, 'Coles Full Cream Milk');
    assert.equal(result.brand, 'Coles');
    assert.equal(result.packageSize, '2L');
    assert.equal(result.price, 3.1);
    assert.equal(result.wasPrice, 3.5);
    assert.equal(result.savingsAmount, 0.4);
    assert.equal(result.isOnSpecial, true);
    assert.equal(result.isHalfPrice, false);
    assert.equal(result.promotion, 'Save $0.40');
    assert.equal(result.isMultibuy, false);
    assert.deepEqual(result.departments, ['Dairy, Eggs & Fridge', 'Milk', 'Full Cream Milk']);
    assert.equal(result.category, 'Full Cream Milk');
    assert.equal(result.productLimit, 20);
    assert.equal(result.cupPrice, 1.55);
    assert.equal(result.cupMeasure, '1L');
    assert.equal(result.cupString, '$1.55 / 1L');
    assert.equal(result.isAvailable, true);
    assert.equal(result.url, 'https://www.coles.com.au/product/coles-full-cream-milk-2l-422493');
    assert.equal(result.imageUrl, 'https://cdn.productimages.coles.com.au/productimages/4/422493.jpg');
    assert.equal(result.source, 'search:milk');
    assert.equal(result.region, 'syd1');
    assert.equal(result.scrapedAt, '2026-11-20T00:00:00.000Z');
});
