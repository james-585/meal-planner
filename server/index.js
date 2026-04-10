import express from 'express';
import fetch from 'node-fetch';
import cookieParser from 'cookie-parser';
import * as cheerio from 'cheerio';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static(join(__dirname, '..', 'public')));

// ═══════════════════════════════════════════════════════════════
//  WOOLWORTHS SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════════
// Woolworths requires cookies from an initial page load before
// API calls will work. We bootstrap a session on server start
// and refresh it periodically.

let wwSession = { cookies: '', lastRefresh: 0 };

async function refreshWoolworthsSession() {
  try {
    // Hit the homepage to get initial cookies
    const resp = await fetch('https://www.woolworths.com.au/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
      redirect: 'follow',
    });

    // Collect all Set-Cookie headers
    const setCookies = resp.headers.raw()['set-cookie'] || [];
    const cookieStr = setCookies.map(c => c.split(';')[0]).join('; ');

    if (cookieStr) {
      wwSession = { cookies: cookieStr, lastRefresh: Date.now() };
      console.log('✓ Woolworths session refreshed');
    }
  } catch (err) {
    console.error('✗ Failed to refresh Woolworths session:', err.message);
  }
}

function getWwHeaders(extraCookies = '') {
  const cookies = [wwSession.cookies, extraCookies].filter(Boolean).join('; ');
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-AU,en;q=0.9',
    'Content-Type': 'application/json',
    'Origin': 'https://www.woolworths.com.au',
    'Referer': 'https://www.woolworths.com.au/shop/search/products',
    ...(cookies ? { 'Cookie': cookies } : {}),
  };
}

// Refresh session on start and every 30 minutes
refreshWoolworthsSession();
setInterval(refreshWoolworthsSession, 30 * 60 * 1000);


// ═══════════════════════════════════════════════════════════════
//  1. RECIPE IMPORT FROM URL
// ═══════════════════════════════════════════════════════════════
// Fetches a recipe URL, extracts JSON-LD schema.org/Recipe data,
// falls back to parsing common recipe HTML patterns.

app.post('/api/import-recipe', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    // Fetch the page
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MealPlanner/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      timeout: 15000,
    });

    if (!resp.ok) {
      return res.status(400).json({ error: `Could not fetch URL (${resp.status})` });
    }

    const html = await resp.text();
    const $ = cheerio.load(html);

    // Method 1: Extract JSON-LD Recipe data
    let recipe = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (recipe) return;
      try {
        let data = JSON.parse($(el).html());

        // Handle @graph arrays (common in WordPress/Yoast)
        if (data['@graph']) data = data['@graph'];
        if (Array.isArray(data)) {
          data = data.find(d => d['@type'] === 'Recipe' || (Array.isArray(d['@type']) && d['@type'].includes('Recipe')));
        }

        if (data && (data['@type'] === 'Recipe' || (Array.isArray(data['@type']) && data['@type'].includes('Recipe')))) {
          recipe = data;
        }
      } catch (e) { /* skip invalid JSON */ }
    });

    if (recipe) {
      // Parse the structured recipe data
      const name = recipe.name || 'Imported Recipe';
      const description = recipe.description || '';
      const servings = recipe.recipeYield
        ? (Array.isArray(recipe.recipeYield) ? recipe.recipeYield[0] : String(recipe.recipeYield))
        : '';
      const prepTime = parseDuration(recipe.prepTime);
      const cookTime = parseDuration(recipe.cookTime);

      // Parse ingredients
      const ingredients = (recipe.recipeIngredient || []).map(ing => {
        if (typeof ing === 'string') return parseIngredientString(ing);
        if (ing.name) return { amount: String(ing.value || ''), unit: '', name: ing.name };
        return { amount: '', unit: '', name: String(ing) };
      });

      // Parse steps
      let steps = [];
      if (recipe.recipeInstructions) {
        if (typeof recipe.recipeInstructions === 'string') {
          steps = recipe.recipeInstructions.split(/\n+/).filter(s => s.trim());
        } else if (Array.isArray(recipe.recipeInstructions)) {
          steps = recipe.recipeInstructions.map(s => {
            if (typeof s === 'string') return s;
            if (s.text) return s.text;
            if (s.itemListElement) {
              return s.itemListElement.map(e => e.text || String(e)).join('\n');
            }
            return String(s.name || s);
          }).filter(s => s.trim());
        }
      }

      // Strip HTML tags from steps
      steps = steps.map(s => s.replace(/<[^>]+>/g, '').trim());

      return res.json({
        success: true,
        recipe: { name, description, servings, prepTime, cookTime, ingredients, steps, sourceUrl: url }
      });
    }

    // Method 2: Fallback — try to find recipe content in meta tags / common structures
    const metaTitle = $('meta[property="og:title"]').attr('content') || $('title').text() || 'Imported Recipe';
    const metaDesc = $('meta[property="og:description"]').attr('content') || '';

    // Try common ingredient list selectors
    const ingredientSelectors = [
      '.recipe-ingredients li', '.ingredients li', '[itemprop="recipeIngredient"]',
      '.ingredient-list li', '.wprm-recipe-ingredient', '.tasty-recipe-ingredients li',
      '.recipe__ingredients li', '.ingredient',
    ];

    let rawIngredients = [];
    for (const sel of ingredientSelectors) {
      const found = $(sel).map((_, el) => $(el).text().trim()).get();
      if (found.length > 0) { rawIngredients = found; break; }
    }

    // Try common step selectors
    const stepSelectors = [
      '.recipe-method li', '.instructions li', '[itemprop="recipeInstructions"] li',
      '.recipe-steps li', '.wprm-recipe-instruction', '.tasty-recipe-instructions li',
      '.recipe__steps li', '.step',
    ];

    let rawSteps = [];
    for (const sel of stepSelectors) {
      const found = $(sel).map((_, el) => $(el).text().trim()).get();
      if (found.length > 0) { rawSteps = found; break; }
    }

    if (rawIngredients.length > 0) {
      return res.json({
        success: true,
        recipe: {
          name: metaTitle.replace(/\s*[-|–].*/,'').trim(),
          description: metaDesc,
          servings: '',
          prepTime: '',
          cookTime: '',
          ingredients: rawIngredients.map(parseIngredientString),
          steps: rawSteps,
          sourceUrl: url,
        }
      });
    }

    // Nothing found
    res.status(422).json({
      error: 'Could not extract recipe data from this page. Try adding manually.',
      partialData: { name: metaTitle.replace(/\s*[-|–].*/,'').trim(), description: metaDesc }
    });

  } catch (err) {
    console.error('Import error:', err.message);
    res.status(500).json({ error: 'Failed to import recipe: ' + err.message });
  }
});

// Parse ISO 8601 duration (PT1H30M) to human-readable
function parseDuration(iso) {
  if (!iso) return '';
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return iso;
  const parts = [];
  if (match[1]) parts.push(`${match[1]} hr`);
  if (match[2]) parts.push(`${match[2]} min`);
  if (match[3]) parts.push(`${match[3]} sec`);
  return parts.join(' ') || iso;
}

// Parse "2 cups flour" into { amount, unit, name }
function parseIngredientString(str) {
  str = str.replace(/<[^>]+>/g, '').trim();
  const match = str.match(/^([\d\/.½¼¾⅓⅔⅛⅜⅝⅞]+(?:\s*[-–to]+\s*[\d\/.½¼¾⅓⅔⅛⅜⅝⅞]+)?)\s*(cups?|tbsp|tsp|tablespoons?|teaspoons?|g|kg|ml|l|litres?|liters?|oz|lbs?|pounds?|bunch(?:es)?|cloves?|cans?|tins?|packets?|pieces?|slices?|pinch(?:es)?|sprigs?|stalks?|heads?|sheets?|rashers?|fillets?|cm|inches?|inch)?\s*(?:of\s+)?(.+)/i);
  if (match) {
    return { amount: match[1].trim(), unit: (match[2] || '').trim(), name: match[3].trim() };
  }
  return { amount: '', unit: '', name: str };
}


// ═══════════════════════════════════════════════════════════════
//  2. WOOLWORTHS PRODUCT SEARCH
// ═══════════════════════════════════════════════════════════════

app.post('/api/woolworths/search', async (req, res) => {
  try {
    const { query, pageSize = 3 } = req.body;
    if (!query) return res.status(400).json({ error: 'Query required' });

    // Ensure session is fresh (refresh if older than 30 min)
    if (Date.now() - wwSession.lastRefresh > 30 * 60 * 1000) {
      await refreshWoolworthsSession();
    }

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
    };

    const response = await fetch('https://www.woolworths.com.au/apis/ui/Search/products', {
      method: 'POST',
      headers: getWwHeaders(),
      body: JSON.stringify(searchPayload),
    });

    if (!response.ok) {
      // If blocked, try refreshing session and retry once
      if (response.status === 403 || response.status === 429) {
        await refreshWoolworthsSession();
        const retry = await fetch('https://www.woolworths.com.au/apis/ui/Search/products', {
          method: 'POST',
          headers: getWwHeaders(),
          body: JSON.stringify(searchPayload),
        });
        if (!retry.ok) {
          return res.status(retry.status).json({ error: 'Woolworths search blocked', status: retry.status });
        }
        const data = await retry.json();
        return res.json(extractProducts(data));
      }
      return res.status(response.status).json({ error: 'Search failed', status: response.status });
    }

    const data = await response.json();
    res.json(extractProducts(data));
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

function extractProducts(data) {
  const products = [];
  if (data.Products) {
    for (const group of data.Products) {
      if (group.Products) {
        for (const p of group.Products) {
          if (p.IsAvailable === false) continue;
          products.push({
            stockcode: p.Stockcode,
            name: p.Name,
            brand: p.Brand || '',
            price: p.Price,
            wasPrice: p.WasPrice,
            isOnSpecial: p.IsOnSpecial,
            packageSize: p.PackageSize || '',
            cupString: p.CupString || '',
            image: p.MediumImageFile || p.SmallImageFile || '',
            unit: p.Unit || 'Each',
            productUrl: `https://www.woolworths.com.au/shop/productdetails/${p.Stockcode}/${(p.UrlFriendlyName || p.Name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          });
        }
      }
    }
  }
  return { products, total: data.SearchResultsCount || 0 };
}


// ═══════════════════════════════════════════════════════════════
//  3. BATCH PRODUCT SEARCH
// ═══════════════════════════════════════════════════════════════

app.post('/api/woolworths/batch-search', async (req, res) => {
  try {
    const { ingredients } = req.body;
    if (!ingredients || !Array.isArray(ingredients)) {
      return res.status(400).json({ error: 'ingredients array required' });
    }

    // Ensure fresh session
    if (Date.now() - wwSession.lastRefresh > 30 * 60 * 1000) {
      await refreshWoolworthsSession();
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
          IsSpecial: false, IsBundle: false, IsMobile: false,
          Filters: [], token: '',
        };

        const response = await fetch('https://www.woolworths.com.au/apis/ui/Search/products', {
          method: 'POST',
          headers: getWwHeaders(),
          body: JSON.stringify(searchPayload),
        });

        if (response.ok) {
          const data = await response.json();
          const { products } = extractProducts(data);
          results.push({
            ingredient: ing.name,
            searchTerm: ing.searchTerm,
            matches: products.slice(0, 3),
            selectedIdx: products.length > 0 ? 0 : -1,
          });
        } else {
          results.push({ ingredient: ing.name, searchTerm: ing.searchTerm, matches: [], selectedIdx: -1 });
        }

        // Be respectful — 400ms between requests
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        results.push({ ingredient: ing.name, searchTerm: ing.searchTerm, matches: [], selectedIdx: -1 });
      }
    }

    res.json({ results });
  } catch (err) {
    console.error('Batch search error:', err.message);
    res.status(500).json({ error: 'Batch search failed' });
  }
});


// ═══════════════════════════════════════════════════════════════
//  4. WOOLWORTHS CART — OPTION 1: Server-side with user cookies
// ═══════════════════════════════════════════════════════════════
// The user logs into Woolworths via our app. We proxy the login,
// store their session cookies, and use them to add items to cart.

// Step A: Proxy login
app.post('/api/woolworths/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // First, get a fresh session with CSRF tokens
    const initResp = await fetch('https://www.woolworths.com.au/shop/securelogin', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      redirect: 'follow',
    });

    const initCookies = (initResp.headers.raw()['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    // Attempt login via Woolworths auth API
    const loginResp = await fetch('https://www.woolworths.com.au/apis/ui/Login', {
      method: 'POST',
      headers: {
        ...getWwHeaders(initCookies),
        'Referer': 'https://www.woolworths.com.au/shop/securelogin',
      },
      body: JSON.stringify({
        username: email,
        password: password,
        rememberMe: false,
      }),
      redirect: 'manual',
    });

    const loginCookies = (loginResp.headers.raw()['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const allCookies = [initCookies, loginCookies].filter(Boolean).join('; ');

    // Check if login was successful
    const loginData = loginResp.ok ? await loginResp.json().catch(() => null) : null;

    if (loginData && loginData.Authenticated) {
      // Store encrypted cookies in a signed httpOnly cookie on our server
      const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2);

      // In-memory session store (use Redis in production)
      if (!global._wwSessions) global._wwSessions = {};
      global._wwSessions[sessionId] = {
        cookies: allCookies,
        email: email,
        createdAt: Date.now(),
      };

      // Clean up old sessions (older than 4 hours)
      for (const [k, v] of Object.entries(global._wwSessions)) {
        if (Date.now() - v.createdAt > 4 * 60 * 60 * 1000) delete global._wwSessions[k];
      }

      res.cookie('ww_session', sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 4 * 60 * 60 * 1000, // 4 hours
      });

      res.json({ success: true, email });
    } else {
      res.status(401).json({ error: 'Login failed. Check your email and password.' });
    }
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

// Step B: Check login status
app.get('/api/woolworths/auth-status', (req, res) => {
  const sessionId = req.cookies.ww_session;
  if (!sessionId || !global._wwSessions?.[sessionId]) {
    return res.json({ loggedIn: false });
  }
  const session = global._wwSessions[sessionId];
  res.json({ loggedIn: true, email: session.email });
});

// Step C: Logout
app.post('/api/woolworths/logout', (req, res) => {
  const sessionId = req.cookies.ww_session;
  if (sessionId && global._wwSessions?.[sessionId]) {
    delete global._wwSessions[sessionId];
  }
  res.clearCookie('ww_session');
  res.json({ success: true });
});

// Step D: Add items to cart using stored session
app.post('/api/woolworths/add-to-cart', async (req, res) => {
  try {
    const { items } = req.body; // [{ stockcode, quantity }]
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array required' });
    }

    const sessionId = req.cookies.ww_session;
    const session = sessionId && global._wwSessions?.[sessionId];

    if (!session) {
      return res.status(401).json({
        error: 'Not logged in to Woolworths',
        requiresLogin: true,
      });
    }

    // Add items one at a time using the Woolworths cart API
    const results = [];
    let successCount = 0;

    for (const item of items) {
      try {
        const addResp = await fetch('https://www.woolworths.com.au/apis/ui/Trolley/Update', {
          method: 'POST',
          headers: getWwHeaders(session.cookies),
          body: JSON.stringify({
            items: [{
              stockcode: item.stockcode,
              quantity: item.quantity || 1,
              isNew: true,
            }],
          }),
        });

        if (addResp.ok) {
          const data = await addResp.json();
          successCount++;
          results.push({ stockcode: item.stockcode, success: true });
        } else {
          const status = addResp.status;
          // If 401/403, session may have expired
          if (status === 401 || status === 403) {
            return res.status(401).json({
              error: 'Woolworths session expired. Please log in again.',
              requiresLogin: true,
              addedSoFar: successCount,
            });
          }
          results.push({ stockcode: item.stockcode, success: false, status });
        }

        // Small delay between cart operations
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        results.push({ stockcode: item.stockcode, success: false, error: e.message });
      }
    }

    res.json({ success: successCount > 0, addedCount: successCount, total: items.length, results });
  } catch (err) {
    console.error('Add to cart error:', err.message);
    res.status(500).json({ error: 'Failed to add items to cart' });
  }
});


// ═══════════════════════════════════════════════════════════════
//  5. FALLBACK: Generate product deep links
// ═══════════════════════════════════════════════════════════════
// When Option 1 fails or user isn't logged in, generate direct
// links to each product page on woolworths.com.au

app.post('/api/woolworths/product-links', (req, res) => {
  const { products } = req.body;
  if (!products || !Array.isArray(products)) {
    return res.status(400).json({ error: 'products array required' });
  }

  const links = products.filter(p => p.stockcode).map(p => ({
    name: p.name,
    stockcode: p.stockcode,
    url: `https://www.woolworths.com.au/shop/productdetails/${p.stockcode}`,
    searchUrl: `https://www.woolworths.com.au/shop/search/products?searchTerm=${encodeURIComponent(p.name || '')}`,
  }));

  res.json({ links });
});


// ═══════════════════════════════════════════════════════════════
//  CATCH-ALL
// ═══════════════════════════════════════════════════════════════

app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🍽️  Meal Planner running at http://localhost:${PORT}\n`);
  console.log(`  ✓ Recipe import (JSON-LD + HTML scraping)`);
  console.log(`  ✓ Woolworths product search (session-managed)`);
  console.log(`  ✓ Cart integration (auth + fallback links)`);
  console.log('');
});
