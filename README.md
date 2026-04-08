# Demo Cloner Worker

Automated website cloner for the Magic Demo flow. Triggered via GitHub Actions `repository_dispatch` events from the Demo Portal.

## How It Works

1. Portal sends a `clone-website` dispatch event with `{ url, demoId, callbackUrl, demoConfig }`
2. GitHub Actions spins up a runner with Playwright + Node.js
3. The cloner pipeline:
   - Takes screenshots at 3 viewports (desktop, tablet, mobile)
   - Extracts DOM structure with computed styles via CDP (`getComputedStyle()`)
   - Downloads all assets (images, fonts, videos, SVGs)
   - Calls Claude API to generate a pixel-perfect static HTML clone
   - Injects the demo overlay button
   - Uploads the static bundle to Supabase Storage
4. Sends a callback to the portal marking the demo as ready

## Local Testing

```bash
npm install
npx playwright install chromium

# Dry run (no upload/callback)
TARGET_URL="https://example.com" \
DEMO_ID="test-123" \
ANTHROPIC_API_KEY="sk-..." \
node scripts/clone-and-deploy.mjs --dry-run
```

Output will be in `output/` directory.

## Required Secrets (GitHub)

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key for HTML generation |
| `SUPABASE_URL` | Demo Portal Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `CLONE_WEBHOOK_SECRET` | Shared secret for callback auth |

## Architecture

```
scripts/
  clone-and-deploy.mjs   # Main orchestration pipeline
  extract-dom.mjs        # DOM extraction script (runs in browser context)
  overlay-inject.mjs     # Demo button injection
  upload-to-supabase.mjs # Supabase Storage upload
.github/workflows/
  clone-website.yml      # GitHub Actions trigger
```

## Cost

- ~$2-5 per clone (Claude API, Sonnet)
- ~10 min GitHub Actions per clone
- 2,000 free Actions min/month covers ~50 clones
