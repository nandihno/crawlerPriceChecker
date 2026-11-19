import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProduct, parseStockcode, parseCupString } from '../src/normalize.js';

test('parseStockcode handles 18-digit zero-padded ALDI SKUs as positive integers', () => {
    assert.equal(parseStockcode('000000000000385792'), 385792);
    assert.equal(parseStockcode('385792'), 385792);
    assert.equal(parseStockcode(12345), 12345);
    assert.equal(parseStockcode(''), null);
    assert.equal(parseStockcode(null), null);

    const hashed = parseStockcode('ALDI-ABC');
    assert.equal(typeof hashed, 'number');
    assert.ok(Number.isSafeInteger(hashed) && hashed > 0);
});

test('parseCupString extracts unit price and unit measure', () => {
    assert.deepEqual(parseCupString('$1.55 per 1L', 155), {
        cupPrice: 1.55,
        cupMeasure: '1L',
        cupString: '$1.55 per 1L',
    });
    assert.deepEqual(parseCupString('$0.75 / 100g', null), {
        cupPrice: 0.75,
        cupMeasure: '100g',
        cupString: '$0.75 / 100g',
    });
});

test('normalizeProduct maps ALDI v3 payload to Supabase ingest-apify-run schema', () => {
    const sample = {
        sku: '000000000000385792',
        name: 'Farmdale Full Cream Milk 2L',
        brandName: 'Farmdale',
        sellingSize: '2L',
        urlSlugText: 'farmdale-full-cream-milk-2l',
        price: {
            amountRelevant: 310,
            amountRelevantDisplay: '$3.10',
            wasPriceDisplay: '$3.50',
            comparison: 155,
            comparisonDisplay: '$1.55 per 1L',
        },
        categories: [
            { name: 'Dairy, Eggs & Fridge' },
            { name: 'Milk' },
        ],
        assets: [
            { url: 'https://dm.apac.cms.aldi.cx/is/image/aldiprodpac/{width}/{slug}.jpg' },
        ],
        notForSale: true,
    };

    const result = normalizeProduct(sample, {
        source: 'search:milk',
        region: 'syd1',
        scrapedAt: '2026-11-19T01:00:00.000Z',
    });

    assert.equal(result.chain, 'aldi');
    assert.equal(result.stockcode, 385792);
    assert.equal(result.name, 'Farmdale Full Cream Milk 2L');
    assert.equal(result.brand, 'Farmdale');
    assert.equal(result.packageSize, '2L');
    assert.equal(result.price, 3.1);
    assert.equal(result.wasPrice, 3.5);
    assert.equal(result.savingsAmount, 0.4);
    assert.equal(result.isOnSpecial, true);
    assert.equal(result.isHalfPrice, false);
    assert.deepEqual(result.departments, ['Dairy, Eggs & Fridge', 'Milk']);
    assert.equal(result.category, 'Milk');
    assert.equal(result.cupPrice, 1.55);
    assert.equal(result.cupMeasure, '1L');
    assert.equal(result.cupString, '$1.55 per 1L');
    assert.equal(result.isAvailable, true);
    assert.equal(result.url, 'https://www.aldi.com.au/product/farmdale-full-cream-milk-2l-000000000000385792');
    assert.equal(result.imageUrl, 'https://dm.apac.cms.aldi.cx/is/image/aldiprodpac/500/farmdale-full-cream-milk-2l.jpg');
    assert.equal(result.source, 'search:milk');
    assert.equal(result.region, 'syd1');
    assert.equal(result.scrapedAt, '2026-11-19T01:00:00.000Z');
});
