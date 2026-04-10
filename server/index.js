import express from 'express';
import fetch from 'node-fetch';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(join(__dirname, '..', 'public')));

const WW_BASE = 'https://www.woolworths.com.au';
const WW_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-AU,en;q=0.9',
    'Content-Type': 'application/json',
    'Origin': WW_BASE,
    'Referer': `${WW_BASE}/shop/search/products`,
};

app.post('/api/woolworths/search', async (req, res) => {
    try {
        const { query, pageSize = 1 } = req.body;
        if (!query) return res.status(400).json({ error: 'Query required' });

        const searchPayload = {
            SearchTerm: query,
            PageSize: pageSize,
            PageNumber: 1,
            SortType: 'TraderRelevance',
            Location: `/shop/search/products?searchTerm=${encodeURIComponent(query)}`,
            IsSpecial: false,
            IsBundle: false,
            IsMobile: false,
            Filters: [],
            token: '',
            EnableAdReRanking: false,
            GroupEdm498: true,
            AdDebugMode: false,
        };

        const response = await fetch(`${WW_BASE}/apis/ui/Search/products`, {
            method: 'POST',
            headers: WW_HEADERS,
            body: JSON.stringify(searchPayload),
        });

        if (!response.ok) {
            console.error(`Woolworths search failed: ${response.status}`);
            return res.status(response.status).json({ error: 'Woolworths search failed' });
        }

        const data = await response.json();
        const products = [];
        if (data.Products) {
            for (const group of data.Products) {
                if (group.Products) {
                    for (const p of group.Products) {
                        products.push({
                            stockcode: p.Stockcode,
                            name: p.Name,
                            brand: p.Brand || '',
                            description: p.Description || '',
                            price: p.Price,
                            wasPrice: p.WasPrice,
                            isOnSpecial: p.IsOnSpecial,
                            isAvailable: p.IsAvailable,
                            isInStock: p.IsInStock,
                            packageSize: p.PackageSize || '',
                            cupPrice: p.CupPrice,
                            cupString: p.CupString || '',
                            image: p.MediumImageFile || p.SmallImageFile || '',
                            unit: p.Unit || 'Each',
                        });
                    }
                }
            }
        }
        res.json({ products, total: data.SearchResultsCount || 0 });
    } catch (err) {
        console.error('Search error:', err.message);
        res.status(500).json({ error: 'Search failed' });
    }
});

app.post('/api/woolworths/batch-search', async (req, res) => {
    try {
        const { ingredients } = req.body;
        if (!ingredients || !Array.isArray(ingredients)) {
            return res.status(400).json({ error: 'ingredients array required' });
        }

        const results = [];
        for (const ing of ingredients) {
            try {
                const searchPayload = {
                    SearchTerm: ing.searchTerm,
                    PageSize: 3,
                    PageNumber: 1,
                    SortType: 'TraderRelevance',
                    Location: `/shop/search/products?searchTerm=${encodeURIComponent(ing.searchTerm)}`,
                    IsSpecial: false,
                    IsBundle: false,
                    IsMobile: false,
                    Filters: [],
                    token: '',
                };

                const response = await fetch(`${WW_BASE}/apis/ui/Search/products`, {
                    method: 'POST',
                    headers: WW_HEADERS,
                    body: JSON.stringify(searchPayload),
                });

                if (response.ok) {
                    const data = await response.json();
                    const products = [];
                    if (data.Products) {
                        for (const group of data.Products) {
                            if (group.Products) {
                                for (const p of group.Products) {
                                    if (p.IsAvailable !== false) {
                                        products.push({
                                            stockcode: p.Stockcode,
                                            name: p.Name,
                                            brand: p.Brand || '',
                                            price: p.Price,
                                            wasPrice: p.WasPrice,
                                            isOnSpecial: p.IsOnSpecial,
                                            isAvailable: p.IsAvailable,
                                            packageSize: p.PackageSize || '',
                                            cupString: p.CupString || '',
                                            image: p.MediumImageFile || p.SmallImageFile || '',
                                            unit: p.Unit || 'Each',
                                        });
                                    }
                                }
                            }
                        }
                    }
                    results.push({
                        ingredient: ing.name,
                        searchTerm: ing.searchTerm,
                        matches: products.slice(0, 3),
                        selectedIdx: 0,
                    });
                } else {
                    results.push({
                        ingredient: ing.name,
                        searchTerm: ing.searchTerm,
                        matches: [],
                        selectedIdx: -1
                    });
                }
                await new Promise(r => setTimeout(r, 300));
            } catch (e) {
                results.push({
                    ingredient: ing.name,
                    searchTerm: ing.searchTerm,
                    matches: [],
                    selectedIdx: -1
                });
            }
        }
        res.json({ results });
    } catch (err) {
        console.error('Batch search error:', err.message);
        res.status(500).json({ error: 'Batch search failed' });
    }
});

app.post('/api/woolworths/add-to-cart', async (req, res) => {
    try {
        const { items } = req.body;
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'items array required' });
        }

        const cartItems = items.map(i => `${i.stockcode}_${i.quantity || 1}`).join(',');
        const addToCartUrl = `${WW_BASE}/shop/cart?addToCart=${cartItems}`;
        res.json({
            success: true,
            cartUrl: addToCartUrl,
            method: 'redirect',
            itemCount: items.length,
        });
    } catch (err) {
        console.error('Add to cart error:', err.message);
        res.status(500).json({ error: 'Add to cart failed' });
    }
});

app.post('/api/woolworths/cart-url', async (req, res) => {
    try {
        const { products } = req.body;
        if (!products || !Array.isArray(products)) {
            return res.status(400).json({ error: 'products array required' });
        }

        const params = products
            .filter(p => p.stockcode)
            .map(p => `${p.stockcode}_${p.quantity || 1}`)
            .join(',');
        res.json({
            cartUrl: `${WW_BASE}/shop/cart?addToCart=${params}`,
            searchUrl: `${WW_BASE}/shop/search/products`,
            itemCount: products.filter(p => p.stockcode).length,
        });
    } catch (err) {
        console.error('Cart URL error:', err.message);
        res.status(500).json({ error: 'Failed to generate cart URL' });
    }
});

app.get('/api/woolworths/product/:stockcode', async (req, res) => {
    try {
        const { stockcode } = req.params;
        const response = await fetch(`${WW_BASE}/apis/ui/product/detail/${stockcode}`, {
            headers: WW_HEADERS,
        });

        if (!response.ok) {
            return res.status(response.status).json({ error: 'Product not found' });
        }

        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error('Product detail error:', err.message);
        res.status(500).json({ error: 'Failed to get product details' });
    }
});

app.get('*', (req, res) => {
    res.sendFile(join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`\n🍽️  Meal Planner running at http://localhost:${PORT}\n`);
    console.log(`  Features:`);
    console.log(`  • Recipe management (manual + URL import)`);
    console.log(`  • Weekly meal planning`);
    console.log(`  • AI-powered ingredient matching`);
    console.log(`  • Woolworths product search & cart integration\n`);
});