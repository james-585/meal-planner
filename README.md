# 🍽 Meal Planner with Woolworths Integration

A full-stack PWA for meal planning with direct Woolworths Australia cart integration. Add recipes (manually or via URL), plan your weekly meals, generate a shopping list, and send it all to your Woolworths cart in one click.

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────┐
│                   Browser (PWA)                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Recipes  │  │ Planner  │  │   Shopping    │  │
│  │   Tab    │  │   Tab    │  │     Tab       │  │
│  └──────────┘  └──────────┘  └───────┬───────┘  │
│                                      │          │
│                        "Send to Woolworths"     │
│                                      │          │
└──────────────────────────────────────┼──────────┘
                                       │
                                       ▼
                    ┌──────────────────────────────┐
                    │     Express.js Backend        │
                    │                              │
                    │  /api/woolworths/search       │
                    │  /api/woolworths/batch-search │
                    │  /api/woolworths/cart-url     │
                    │  /api/woolworths/product/:id  │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │   Woolworths Internal APIs    │
                    │                              │
                    │  /apis/ui/Search/products    │
                    │  /apis/ui/product/detail/:id │
                    │  /shop/cart?addToCart=...     │
                    └──────────────────────────────┘
```

### Woolworths Integration Flow

1. **Batch Product Search** — Each ingredient is searched against Woolworths' product catalog via their internal search API (the same one their website uses)
2. **Product Selection** — You see the top 3 matches for each ingredient with prices, images, and package sizes. You can swap products by tapping alternatives
3. **Cart URL Generation** — Selected products are compiled into a Woolworths cart URL using the `addToCart` parameter format: `/shop/cart?addToCart=STOCKCODE1_QTY,STOCKCODE2_QTY,...`
4. **One-Click Add** — Opening this URL while logged into woolworths.com.au adds all items to your cart automatically

### Key Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/woolworths/search` | POST | Search products by keyword |
| `/api/woolworths/batch-search` | POST | Search multiple ingredients at once |
| `/api/woolworths/cart-url` | POST | Generate a cart URL from selected products |
| `/api/woolworths/product/:stockcode` | GET | Get full product details |

## Setup

```bash
# Install dependencies
npm install

# Start the server
npm start

# Or with auto-reload during development
npm run dev
```

Then open `http://localhost:3000` in your browser.

## Usage

### 1. Add Recipes
- Tap **+** to add a recipe manually with ingredients and method
- Or tap **🔗** to import from a URL

### 2. Plan Your Week
- Go to the **Planner** tab
- Add meals to each day by tapping "+ Add meal"

### 3. Generate Shopping List
- Tap **Generate List** — ingredients are merged and grouped by aisle

### 4. Send to Woolworths
- Tap **Send to Woolworths Cart**
- The app searches each ingredient on Woolworths
- Review and swap products as needed
- See the estimated total
- Tap **Add to Woolworths Cart** — opens woolworths.com.au with everything in your cart
- Log in and checkout!

## Tech Stack

- **Backend**: Node.js + Express
- **Frontend**: Vanilla JS PWA (no framework dependencies)
- **Storage**: localStorage (upgrade to SQLite/Postgres for multi-user)
- **Woolworths**: Undocumented internal APIs (same as their website)

## Deployment

Deploy to any Node.js host (Railway, Render, Fly.io, etc.):

```bash
# Railway
railway deploy

# Or Docker
docker build -t meal-planner .
docker run -p 3000:3000 meal-planner
```

## Important Notes

- The Woolworths API endpoints are undocumented and may change
- The `addToCart` URL method requires the user to be logged into woolworths.com.au
- Rate limiting: the batch search adds 300ms delays between requests to be respectful
- This project is for personal use — Woolworths may block excessive API usage

## Future Enhancements

- Claude API integration for recipe URL import
- User accounts with server-side storage
- Coles integration
- Pantry tracking (skip items you already have)
- Price history and specials alerts
"# meal-planner" 
"# meal-planner" 
