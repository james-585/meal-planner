import express from 'express';
import fetch, { AbortError } from 'node-fetch';
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
//  FETCH WITH TIMEOUT — never hang
// ═══════════════════════════════════════════════════════════════
async function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// Try to parse JSON, return null if body is HTML/not JSON
async function safeJson(resp) {
  const text = await resp.text();
  // Woolworths sometimes returns HTML (captcha/block page) with 200 status
  if (text.trimStart().startsWith('<') || text.trimStart().startsWith('<!')) {
    return null;
  }
  try { return JSON.parse(text); } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
//  WOOLWORTHS SESSION
// ═══════════════════════════════════════════════════════════════
let wwSession = { cookies: '', lastRefresh: 0 };

async function refreshWoolworthsSession() {
  try {
    const resp = await fetchWithTimeout('https://www.woolworths.com.au/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
      redirect: 'follow',
    }, 15000);

    const setCookies = resp.headers.raw()['set-cookie'] || [];
    const cookieStr = setCookies.map(c => c.split(';')[0]).join('; ');
    if (cookieStr) {
      wwSession = { cookies: cookieStr, lastRefresh: Date.now() };
      console.log('✓ Woolworths session refreshed (' + setCookies.length + ' cookies)');
    } else {
      console.log('⚠ Woolworths returned no cookies');
    }
  } catch (err) {
    console.error('✗ Session refresh failed:', err.message);
  }
}

function getWwHeaders(extra = '') {
  const cookies = [wwSession.cookies, extra].filter(Boolean).join('; ');
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-AU,en;q=0.9',
    'Content-Type': 'application/json',
    'Origin': 'https://www.woolworths.com.au',
    'Referer': 'https://www.woolworths.com.au/shop/search/products',
    ...(cookies ? { Cookie: cookies } : {}),
  };
}

refreshWoolworthsSession();
setInterval(refreshWoolworthsSession, 25 * 60 * 1000);


// ═══════════════════════════════════════════════════════════════
//  IMPERIAL → METRIC CONVERSION
// ═══════════════════════════════════════════════════════════════
function convertToMetric(amount, unit) {
  if (!amount || !unit) return { amount, unit };
  const num = parseFloat(amount);
  if (isNaN(num)) return { amount, unit };
  const u = unit.toLowerCase().replace(/s$/, '').replace(/\./, '');

  // Weight: lbs/pounds → grams (round to nearest 50g)
  if (u === 'lb' || u === 'pound') {
    const grams = Math.round((num * 453.592) / 50) * 50;
    return { amount: String(grams), unit: 'g' };
  }
  // Ounces → grams (round to nearest 50g for amounts > 100g, nearest 10g otherwise)
  if (u === 'oz' || u === 'ounce') {
    const grams = num * 28.3495;
    if (grams >= 100) return { amount: String(Math.round(grams / 50) * 50), unit: 'g' };
    return { amount: String(Math.round(grams / 10) * 10), unit: 'g' };
  }
  // Fluid ounces → ml
  if (u === 'fl oz' || u === 'fluid ounce' || u === 'fl_oz') {
    return { amount: String(Math.round(num * 29.5735)), unit: 'ml' };
  }
  // Inches → cm
  if (u === 'inch' || u === 'inche' || u === 'in') {
    return { amount: String(Math.round(num * 2.54)), unit: 'cm' };
  }
  // Fahrenheit in instructions handled separately
  return { amount, unit };
}


// ═══════════════════════════════════════════════════════════════
//  1. RECIPE IMPORT FROM URL
// ═══════════════════════════════════════════════════════════════

app.post('/api/import-recipe', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    // Validate URL
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) return res.status(400).json({ error: 'Invalid URL' });

    const resp = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MealPlanner/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    }, 15000);

    if (!resp.ok) return res.status(400).json({ error: `Could not fetch URL (${resp.status})` });

    const html = await resp.text();
    const $ = cheerio.load(html);

    // ── PASS 1: Extract JSON-LD Recipe ──
    let rawRecipe = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (rawRecipe) return;
      try {
        let data = JSON.parse($(el).html());
        if (data['@graph']) data = data['@graph'];
        if (Array.isArray(data)) data = data.find(d => {
          const t = d['@type'];
          return t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'));
        });
        if (data && (data['@type'] === 'Recipe' || (Array.isArray(data['@type']) && data['@type'].includes('Recipe')))) {
          rawRecipe = data;
        }
      } catch {}
    });

    if (!rawRecipe) {
      // Fallback: try common HTML selectors
      const ingredientSelectors = [
        '.recipe-ingredients li', '.ingredients li', '[itemprop="recipeIngredient"]',
        '.ingredient-list li', '.wprm-recipe-ingredient', '.tasty-recipe-ingredients li',
      ];
      let rawIngs = [];
      for (const sel of ingredientSelectors) {
        const found = $(sel).map((_, el) => $(el).text().trim()).get().filter(Boolean);
        if (found.length > 1) { rawIngs = found; break; }
      }

      if (rawIngs.length < 2) {
        const title = $('meta[property="og:title"]').attr('content') || $('title').text() || '';
        return res.status(422).json({
          error: 'Could not find recipe data on this page. Try adding manually.',
          partialData: { name: title.replace(/\s*[-|–].*/,'').trim() }
        });
      }

      // Convert & validate
      const ingredients = rawIngs.map(s => {
        const parsed = parseIngredientString(s);
        const converted = convertToMetric(parsed.amount, parsed.unit);
        return { ...parsed, amount: converted.amount, unit: converted.unit };
      });

      const stepSelectors = ['.recipe-method li','.instructions li','[itemprop="recipeInstructions"] li','.recipe-steps li','.wprm-recipe-instruction','.tasty-recipe-instructions li'];
      let steps = [];
      for (const sel of stepSelectors) {
        const found = $(sel).map((_, el) => $(el).text().trim()).get().filter(Boolean);
        if (found.length > 0) { steps = found; break; }
      }

      const name = $('meta[property="og:title"]').attr('content') || $('h1').first().text() || 'Imported Recipe';

      // ── PASS 2: VALIDATE (anti-hallucination) ──
      const validated = validateRecipe({ name: name.replace(/\s*[-|–].*/,'').trim(), description: '', servings: '', prepTime: '', cookTime: '', ingredients, steps, sourceUrl: url });

      return res.json({ success: true, recipe: validated });
    }

    // ── Parse structured JSON-LD data ──
    const name = rawRecipe.name || 'Imported Recipe';
    const description = typeof rawRecipe.description === 'string' ? rawRecipe.description : '';
    const servings = rawRecipe.recipeYield
      ? (Array.isArray(rawRecipe.recipeYield) ? rawRecipe.recipeYield[0] : String(rawRecipe.recipeYield))
      : '';
    const prepTime = parseDuration(rawRecipe.prepTime);
    const cookTime = parseDuration(rawRecipe.cookTime);

    // Parse ingredients
    let ingredients = (rawRecipe.recipeIngredient || []).map(ing => {
      const parsed = typeof ing === 'string' ? parseIngredientString(ing) : { amount: String(ing.value || ''), unit: '', name: ing.name || String(ing) };
      const converted = convertToMetric(parsed.amount, parsed.unit);
      return { ...parsed, amount: converted.amount, unit: converted.unit };
    });

    // Parse steps
    let steps = [];
    if (rawRecipe.recipeInstructions) {
      if (typeof rawRecipe.recipeInstructions === 'string') {
        steps = rawRecipe.recipeInstructions.split(/\n+/).filter(s => s.trim());
      } else if (Array.isArray(rawRecipe.recipeInstructions)) {
        for (const s of rawRecipe.recipeInstructions) {
          if (typeof s === 'string') { steps.push(s); }
          else if (s['@type'] === 'HowToStep' && s.text) { steps.push(s.text); }
          else if (s['@type'] === 'HowToSection' && Array.isArray(s.itemListElement)) {
            for (const sub of s.itemListElement) { steps.push(sub.text || String(sub.name || sub)); }
          }
          else if (s.text) { steps.push(s.text); }
          else { steps.push(String(s.name || s)); }
        }
      }
    }
    steps = steps.map(s => s.replace(/<[^>]+>/g, '').trim()).filter(Boolean);

    // ── PASS 2: VALIDATE the extracted recipe ──
    const recipe = validateRecipe({ name, description, servings, prepTime, cookTime, ingredients, steps, sourceUrl: url });

    res.json({ success: true, recipe });

  } catch (err) {
    console.error('Import error:', err.message);
    res.status(500).json({ error: 'Failed to import: ' + err.message });
  }
});

// ── Validation: catch hallucination / garbage data ──
function validateRecipe(r) {
  // Name: must exist, strip HTML
  r.name = (r.name || 'Imported Recipe').replace(/<[^>]+>/g, '').trim().substring(0, 200);
  if (!r.name) r.name = 'Imported Recipe';

  // Description: cap length, strip HTML
  r.description = (r.description || '').replace(/<[^>]+>/g, '').trim().substring(0, 500);

  // Ingredients: filter out empty, ad-text, navigation items
  const junkPatterns = /^(advertisement|subscribe|sign up|click here|share|print|save|jump to|nutrition|calories per|course:|cuisine:|keyword:|author:|prep time|cook time|total time|servings?:|yield:)/i;

  r.ingredients = (r.ingredients || []).filter(ing => {
    if (!ing.name || ing.name.trim().length < 2) return false;
    if (ing.name.length > 200) return false;
    if (junkPatterns.test(ing.name.trim())) return false;
    return true;
  }).map(ing => ({
    amount: (ing.amount || '').substring(0, 20),
    unit: (ing.unit || '').substring(0, 20),
    name: ing.name.replace(/<[^>]+>/g, '').trim().substring(0, 200),
  }));

  // Steps: filter out empty, junky
  r.steps = (r.steps || []).filter(s => {
    if (!s || s.trim().length < 5) return false;
    if (s.length > 2000) return false;
    if (junkPatterns.test(s.trim())) return false;
    return true;
  }).map(s => s.replace(/<[^>]+>/g, '').trim().substring(0, 2000));

  // Sanity check: a real recipe should have at least 2 ingredients
  if (r.ingredients.length < 1) {
    r._warning = 'Very few ingredients found — please verify.';
  }

  return r;
}

function parseDuration(iso) {
  if (!iso) return '';
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!match) return String(iso).replace('PT','').replace('H',' hr ').replace('M',' min').trim();
  const parts = [];
  if (match[1]) parts.push(`${match[1]} hr`);
  if (match[2]) parts.push(`${match[2]} min`);
  return parts.join(' ') || '';
}

function parseIngredientString(str) {
  str = str.replace(/<[^>]+>/g, '').trim();

  // Handle unicode fractions
  const fracMap = {'½':'.5','¼':'.25','¾':'.75','⅓':'.33','⅔':'.67','⅛':'.125','⅜':'.375','⅝':'.625','⅞':'.875'};
  for (const [f, v] of Object.entries(fracMap)) {
    str = str.replace(new RegExp(`(\\d+)\\s*${f}`,'g'), (_, d) => String(parseFloat(d) + parseFloat(v)));
    str = str.replace(new RegExp(f,'g'), v);
  }

  const match = str.match(/^([\d.]+(?:\s*[-–to]+\s*[\d.]+)?)\s*(cups?|tbsp|tsp|tablespoons?|teaspoons?|g|kg|ml|l|litres?|liters?|oz|fl\s*oz|lbs?|pounds?|bunch(?:es)?|cloves?|cans?|tins?|packets?|pieces?|slices?|pinch(?:es)?|sprigs?|stalks?|heads?|sheets?|rashers?|fillets?|cm|inches?|inch)?\s*(?:of\s+)?(.+)/i);
  if (match) {
    return { amount: match[1].trim(), unit: (match[2] || '').trim(), name: match[3].trim() };
  }
  return { amount: '', unit: '', name: str };
}


// ═══════════════════════════════════════════════════════════════
//  2. WOOLWORTHS PRODUCT SEARCH
// ═══════════════════════════════════════════════════════════════

async function searchWoolworths(query, pageSize = 3) {
  const payload = {
    SearchTerm: query, PageSize: pageSize, PageNumber: 1,
    SortType: 'TraderRelevance',
    Location: `/shop/search/products?searchTerm=${encodeURIComponent(query)}`,
    IsSpecial: false, IsBundle: false, IsMobile: false, Filters: [], token: '',
  };

  const resp = await fetchWithTimeout('https://www.woolworths.com.au/apis/ui/Search/products', {
    method: 'POST',
    headers: getWwHeaders(),
    body: JSON.stringify(payload),
  }, 8000); // 8 second timeout per search

  if (!resp.ok) {
    // Retry once with fresh session on 403
    if (resp.status === 403 || resp.status === 429) {
      await refreshWoolworthsSession();
      const retry = await fetchWithTimeout('https://www.woolworths.com.au/apis/ui/Search/products', {
        method: 'POST', headers: getWwHeaders(), body: JSON.stringify(payload),
      }, 8000);
      if (!retry.ok) return { products: [], total: 0, error: `blocked (${retry.status})` };
      const data = await safeJson(retry);
      return data ? extractProducts(data) : { products: [], total: 0, error: 'non-JSON response' };
    }
    return { products: [], total: 0, error: `status ${resp.status}` };
  }

  const data = await safeJson(resp);
  if (!data) return { products: [], total: 0, error: 'Woolworths returned non-JSON (possible captcha)' };
  return extractProducts(data);
}

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
            productUrl: `https://www.woolworths.com.au/shop/productdetails/${p.Stockcode}/${(p.UrlFriendlyName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'product'}`,
          });
        }
      }
    }
  }
  return { products, total: data.SearchResultsCount || 0 };
}

app.post('/api/woolworths/search', async (req, res) => {
  try {
    const { query, pageSize = 3 } = req.body;
    if (!query) return res.status(400).json({ error: 'Query required' });
    const result = await searchWoolworths(query, pageSize);
    if (result.error) {
      return res.status(200).json({ products: [], total: 0, error: result.error });
    }
    res.json(result);
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(200).json({ products: [], total: 0, error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════
//  3. BATCH SEARCH — with per-item timeout and overall cap
// ═══════════════════════════════════════════════════════════════

app.post('/api/woolworths/batch-search', async (req, res) => {
  try {
    const { ingredients } = req.body;
    if (!ingredients || !Array.isArray(ingredients)) {
      return res.status(400).json({ error: 'ingredients array required' });
    }

    if (Date.now() - wwSession.lastRefresh > 25 * 60 * 1000) {
      await refreshWoolworthsSession();
    }

    const results = [];
    let errors = 0;

    for (const ing of ingredients) {
      try {
        const { products, error } = await searchWoolworths(ing.searchTerm, 3);
        results.push({
          ingredient: ing.name,
          searchTerm: ing.searchTerm,
          matches: products.slice(0, 3),
          selectedIdx: products.length > 0 ? 0 : -1,
          error: error || null,
        });
        if (error) errors++;
      } catch (e) {
        results.push({ ingredient: ing.name, searchTerm: ing.searchTerm, matches: [], selectedIdx: -1, error: e.message });
        errors++;
      }

      // If we're getting blocked, stop early
      if (errors >= 3) {
        // Fill remaining with empty results
        for (let i = results.length; i < ingredients.length; i++) {
          results.push({ ingredient: ingredients[i].name, searchTerm: ingredients[i].searchTerm, matches: [], selectedIdx: -1, error: 'skipped (rate limited)' });
        }
        break;
      }

      await new Promise(r => setTimeout(r, 400));
    }

    // Report if Woolworths is blocking us
    const allBlocked = results.every(r => r.matches.length === 0 && r.error);
    res.json({
      results,
      blocked: allBlocked,
      message: allBlocked ? 'Woolworths may be blocking requests from this server. Use the fallback product links instead.' : null,
    });
  } catch (err) {
    console.error('Batch search error:', err.message);
    res.status(200).json({ results: [], blocked: true, message: 'Search failed: ' + err.message });
  }
});


// ═══════════════════════════════════════════════════════════════
//  4. WOOLWORTHS LOGIN + CART
// ═══════════════════════════════════════════════════════════════
if (!global._wwSessions) global._wwSessions = {};

app.post('/api/woolworths/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const initResp = await fetchWithTimeout('https://www.woolworths.com.au/shop/securelogin', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', Accept: 'text/html' },
      redirect: 'follow',
    }, 10000);
    const initCookies = (initResp.headers.raw()['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    const loginResp = await fetchWithTimeout('https://www.woolworths.com.au/apis/ui/Login', {
      method: 'POST',
      headers: { ...getWwHeaders(initCookies), Referer: 'https://www.woolworths.com.au/shop/securelogin' },
      body: JSON.stringify({ username: email, password, rememberMe: false }),
      redirect: 'manual',
    }, 10000);

    const loginCookies = (loginResp.headers.raw()['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const allCookies = [initCookies, loginCookies].filter(Boolean).join('; ');

    const loginData = await safeJson(loginResp);

    if (loginData && loginData.Authenticated) {
      const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2);
      global._wwSessions[sessionId] = { cookies: allCookies, email, createdAt: Date.now() };

      // Clean old sessions
      for (const [k, v] of Object.entries(global._wwSessions)) {
        if (Date.now() - v.createdAt > 4 * 3600 * 1000) delete global._wwSessions[k];
      }

      res.cookie('ww_session', sessionId, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 4 * 3600 * 1000 });
      res.json({ success: true, email });
    } else {
      res.status(401).json({ error: 'Login failed. Check your email and password.' });
    }
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

app.get('/api/woolworths/auth-status', (req, res) => {
  const sid = req.cookies.ww_session;
  const session = sid && global._wwSessions[sid];
  if (!session || Date.now() - session.createdAt > 4 * 3600 * 1000) {
    return res.json({ loggedIn: false });
  }
  res.json({ loggedIn: true, email: session.email });
});

app.post('/api/woolworths/logout', (req, res) => {
  const sid = req.cookies.ww_session;
  if (sid) delete global._wwSessions[sid];
  res.clearCookie('ww_session');
  res.json({ success: true });
});

app.post('/api/woolworths/add-to-cart', async (req, res) => {
  try {
    const { items } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'items required' });

    const sid = req.cookies.ww_session;
    const session = sid && global._wwSessions[sid];
    if (!session) return res.status(401).json({ error: 'Not logged in', requiresLogin: true });

    let ok = 0;
    const results = [];
    for (const item of items) {
      try {
        const r = await fetchWithTimeout('https://www.woolworths.com.au/apis/ui/Trolley/Update', {
          method: 'POST',
          headers: getWwHeaders(session.cookies),
          body: JSON.stringify({ items: [{ stockcode: item.stockcode, quantity: item.quantity || 1, isNew: true }] }),
        }, 8000);

        if (r.ok) { ok++; results.push({ stockcode: item.stockcode, success: true }); }
        else if (r.status === 401 || r.status === 403) {
          return res.status(401).json({ error: 'Session expired', requiresLogin: true, addedSoFar: ok });
        }
        else { results.push({ stockcode: item.stockcode, success: false }); }
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        results.push({ stockcode: item.stockcode, success: false, error: e.message });
      }
    }
    res.json({ success: ok > 0, addedCount: ok, total: items.length, results });
  } catch (err) {
    res.status(500).json({ error: 'Cart failed: ' + err.message });
  }
});


// ═══════════════════════════════════════════════════════════════
//  5. PRODUCT LINKS FALLBACK
// ═══════════════════════════════════════════════════════════════
app.post('/api/woolworths/product-links', (req, res) => {
  const { products } = req.body;
  if (!products?.length) return res.status(400).json({ error: 'products required' });
  const links = products.filter(p => p.stockcode).map(p => ({
    name: p.name, stockcode: p.stockcode,
    url: `https://www.woolworths.com.au/shop/productdetails/${p.stockcode}`,
  }));
  res.json({ links });
});


// ═══════════════════════════════════════════════════════════════
app.get('*', (req, res) => res.sendFile(join(__dirname, '..', 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n🍽️  Meal Planner running at http://localhost:${PORT}`);
  console.log(`  ✓ Recipe import (JSON-LD + HTML, validated, metric conversion)`);
  console.log(`  ✓ Woolworths search (timeout-protected, retry logic)`);
  console.log(`  ✓ Cart integration (auth + fallback links)\n`);
});
