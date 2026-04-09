#!/usr/bin/env node

/**
 * clone-and-deploy.mjs
 *
 * Main orchestration script for the automated website cloner.
 * Runs inside GitHub Actions (or locally for testing).
 *
 * Pipeline:
 * 1. Launch Playwright browser → navigate to target URL
 * 2. Take reference screenshots at 3 viewports
 * 3. Extract DOM structure with computed styles
 * 4. Download all assets (images, fonts, videos)
 * 5. Call Claude API to generate clean self-contained HTML
 * 6. Inject demo overlay
 * 7. Upload to Supabase Storage
 * 8. POST callback to mark demo as ready
 */

import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractionScript } from './extract-dom.mjs';
import { injectOverlay } from './overlay-inject.mjs';
import { uploadToSupabase } from './upload-to-supabase.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output');
const SCREENSHOTS_DIR = path.join(ROOT, 'screenshots');
const ASSETS_DIR = path.join(OUTPUT_DIR, 'assets');

// Environment variables
const TARGET_URL = process.env.TARGET_URL;
const DEMO_ID = process.env.DEMO_ID;
const CALLBACK_URL = process.env.CALLBACK_URL;
const DEMO_CONFIG = process.env.DEMO_CONFIG ? JSON.parse(process.env.DEMO_CONFIG) : {};
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CLONE_WEBHOOK_SECRET = process.env.CLONE_WEBHOOK_SECRET;
const DRY_RUN = process.argv.includes('--dry-run');

// Viewports for responsive screenshots
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 }
];

async function main() {
  console.log('🚀 Starting website clone pipeline');
  console.log(`   Target URL: ${TARGET_URL}`);
  console.log(`   Demo ID: ${DEMO_ID}`);
  console.log(`   Dry run: ${DRY_RUN}`);

  if (!TARGET_URL) {
    throw new Error('TARGET_URL environment variable is required');
  }

  // Create output directories
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
  await fs.mkdir(ASSETS_DIR, { recursive: true });

  let browser;
  try {
    // ── Step 1: Launch browser ──────────────────────────────────────
    console.log('\n📦 Step 1: Launching browser...');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    // ── Step 2: Take screenshots at all viewports ───────────────────
    console.log('\n📸 Step 2: Taking reference screenshots...');
    const screenshots = {};
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1
      });
      const page = await context.newPage();

      try {
        await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 });
        // Wait a bit for animations/lazy content
        await page.waitForTimeout(2000);

        // Take full-page screenshot for reference, but viewport-only JPEG for Claude API
        const screenshotPath = path.join(SCREENSHOTS_DIR, `${vp.name}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });

        // Also save a viewport-only JPEG (much smaller) for Claude API
        const jpegPath = path.join(SCREENSHOTS_DIR, `${vp.name}_api.jpeg`);
        await page.screenshot({ path: jpegPath, fullPage: false, type: 'jpeg', quality: 70 });
        screenshots[vp.name] = screenshotPath;
        console.log(`   ✅ ${vp.name} screenshot (${vp.width}x${vp.height})`);
      } catch (err) {
        console.warn(`   ⚠️ Failed screenshot for ${vp.name}: ${err.message}`);
      } finally {
        await context.close();
      }
    }

    // ── Step 3: Extract DOM with computed styles ────────────────────
    console.log('\n🔍 Step 3: Extracting DOM structure with computed styles...');
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1
    });
    const page = await context.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Scroll down the page to trigger lazy-loaded content
    await autoScroll(page);

    // Run extraction in page context
    const extraction = await page.evaluate(extractionScript);
    console.log(`   ✅ Extracted ${countNodes(extraction.bodyTree)} elements`);
    console.log(`   📊 Assets found: ${extraction.assets.images.length} images, ${extraction.assets.fonts.length} fonts, ${extraction.assets.backgroundImages.length} bg images`);

    // Save extraction for debugging
    await fs.writeFile(
      path.join(OUTPUT_DIR, 'extraction.json'),
      JSON.stringify(extraction, null, 2)
    );

    // ── Step 4: Download assets ─────────────────────────────────────
    console.log('\n⬇️ Step 4: Downloading assets...');
    const assetMap = await downloadAssets(extraction.assets, ASSETS_DIR, TARGET_URL);
    console.log(`   ✅ Downloaded ${Object.keys(assetMap).length} assets`);

    // ── Step 5: Generate HTML via Claude API ────────────────────────
    console.log('\n🤖 Step 5: Generating HTML via Claude API...');
    const generatedHtml = await generateHtmlWithClaude(extraction, screenshots, assetMap);
    console.log(`   ✅ Generated HTML (${(generatedHtml.length / 1024).toFixed(1)} KB)`);

    // ── Step 6: Inject demo overlay ─────────────────────────────────
    console.log('\n🎯 Step 6: Injecting demo overlay...');
    const finalHtml = injectOverlay(generatedHtml, DEMO_CONFIG);

    // Write final output
    await fs.writeFile(path.join(OUTPUT_DIR, 'index.html'), finalHtml);
    console.log(`   ✅ Final HTML written to output/index.html`);

    // Copy assets
    await fs.cp(ASSETS_DIR, path.join(OUTPUT_DIR, 'assets'), { recursive: true });

    await context.close();

    if (DRY_RUN) {
      console.log('\n🏁 Dry run complete. Output in output/');
      return;
    }

    // ── Step 7: Upload to Supabase Storage ──────────────────────────
    console.log('\n☁️ Step 7: Uploading to Supabase Storage...');
    const storageUrl = await uploadToSupabase(OUTPUT_DIR, DEMO_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY);
    console.log(`   ✅ Uploaded to ${storageUrl}`);

    // ── Step 8: POST callback ───────────────────────────────────────
    console.log('\n📬 Step 8: Sending completion callback...');
    await sendCallback({
      demoId: DEMO_ID,
      storageUrl,
      status: 'ready',
      metadata: {
        extractedElements: countNodes(extraction.bodyTree),
        assetsDownloaded: Object.keys(assetMap).length,
        htmlSize: finalHtml.length,
        screenshotsTaken: Object.keys(screenshots).length,
        clonedAt: new Date().toISOString()
      }
    });

    console.log('\n✅ Clone pipeline complete!');

  } catch (error) {
    console.error('\n❌ Pipeline failed:', error.message);

    // Send failure callback
    if (!DRY_RUN && CALLBACK_URL) {
      await sendCallback({
        demoId: DEMO_ID,
        status: 'failed',
        error: error.message
      }).catch(e => console.error('Failed to send error callback:', e.message));
    }

    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Auto-scroll the page to trigger lazy-loaded content
 */
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0); // scroll back to top
          resolve();
        }
      }, 100);
    });
  });
  await page.waitForTimeout(1000);
}

/**
 * Count nodes in the extraction tree
 */
function countNodes(node) {
  if (!node) return 0;
  let count = 1;
  if (node.children) {
    for (const child of node.children) {
      count += countNodes(child);
    }
  }
  return count;
}

/**
 * Download all discovered assets to local directory
 */
async function downloadAssets(assets, outputDir, baseUrl) {
  const assetMap = {}; // Maps original URL → local path
  const allUrls = [
    ...assets.images.map(i => i.src),
    ...assets.backgroundImages,
    ...assets.fonts,
    ...(assets.videos || []).map(v => v.src).filter(Boolean),
    ...(assets.videos || []).map(v => v.poster).filter(Boolean),
    ...assets.favicons
  ].filter(Boolean);

  // Deduplicate
  const uniqueUrls = [...new Set(allUrls)];

  // Download in batches of 4
  const BATCH_SIZE = 4;
  for (let i = 0; i < uniqueUrls.length; i += BATCH_SIZE) {
    const batch = uniqueUrls.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (url) => {
      try {
        const absoluteUrl = new URL(url, baseUrl).href;
        const response = await fetch(absoluteUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
          signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) return;

        const contentType = response.headers.get('content-type') || '';
        const ext = getExtensionFromUrl(url) || getExtensionFromContentType(contentType) || 'bin';
        const filename = `asset_${hashString(url)}.${ext}`;
        const localPath = path.join(outputDir, filename);

        const buffer = Buffer.from(await response.arrayBuffer());
        await fs.writeFile(localPath, buffer);

        assetMap[url] = `assets/${filename}`;
      } catch (err) {
        // Skip failed downloads
      }
    }));
  }

  return assetMap;
}

function getExtensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).replace('.', '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'webm'].includes(ext)) {
      return ext;
    }
  } catch {}
  return null;
}

function getExtensionFromContentType(ct) {
  const map = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/x-icon': 'ico',
    'font/woff': 'woff', 'font/woff2': 'woff2', 'font/ttf': 'ttf',
    'video/mp4': 'mp4', 'video/webm': 'webm'
  };
  for (const [mime, ext] of Object.entries(map)) {
    if (ct.includes(mime)) return ext;
  }
  return null;
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Generate clean HTML using Claude API
 */
async function generateHtmlWithClaude(extraction, screenshots, assetMap) {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // Prepare the prompt with extraction data
  // Truncate extraction to fit within context limits
  const truncatedTree = truncateTree(extraction.bodyTree, 6, 30);

  // Build asset mapping instructions
  const assetMappings = Object.entries(assetMap)
    .map(([original, local]) => `  "${original}" → "${local}"`)
    .join('\n');

  // Read desktop screenshot as base64 for vision (use JPEG viewport version to stay under 5MB)
  const messageContent = [];

  // Add screenshot if available — prefer the smaller _api.jpeg version
  const apiScreenshot = screenshots.desktop?.replace('.png', '_api.jpeg');
  const screenshotToSend = apiScreenshot || screenshots.desktop;
  if (screenshotToSend) {
    try {
      const screenshotData = await fs.readFile(screenshotToSend);
      const isJpeg = screenshotToSend.endsWith('.jpeg') || screenshotToSend.endsWith('.jpg');
      const base64 = screenshotData.toString('base64');
      // Skip if still over 5MB
      if (screenshotData.length < 5 * 1024 * 1024) {
        messageContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: isJpeg ? 'image/jpeg' : 'image/png',
            data: base64
          }
        });
      } else {
        console.log('   ⚠️ Screenshot still too large for API, sending text-only');
      }
    } catch {}
  }

  messageContent.push({
    type: 'text',
    text: `You are a website cloner. Your job is to produce a single, self-contained HTML file that visually replicates the website shown in the screenshot and described by the DOM extraction below.

## Requirements
1. Output a COMPLETE, valid HTML document (<!DOCTYPE html> through </html>)
2. All styles must be in a <style> block in the <head> — no external CSS files
3. Use the EXACT computed styles from the extraction — do NOT approximate colors, sizes, or spacing
4. Reference local assets using the asset mappings provided (e.g., src="assets/asset_xyz.png")
5. The page must be responsive — it should look correct at desktop (1440px), tablet (768px), and mobile (390px)
6. Preserve ALL text content verbatim from the extraction
7. Do NOT include any JavaScript, forms, or interactive elements — this is a static visual clone
8. Include Google Fonts via <link> tags if fonts were detected
9. Include favicon link if available

## Page Metadata
${JSON.stringify(extraction.metadata, null, 2)}

## HTML/Body Attributes
HTML: ${JSON.stringify(extraction.htmlAttributes)}
Body: ${JSON.stringify(extraction.bodyAttributes)}

## Extracted DOM Tree (with computed styles)
${JSON.stringify(truncatedTree, null, 2)}

## Asset Mappings (original URL → local path)
${assetMappings || '(no assets downloaded)'}

## Google Fonts
${extraction.assets.googleFonts?.join('\n') || '(none detected)'}

## Favicons
${extraction.assets.favicons?.join('\n') || '(none detected)'}

## Important Notes
- Match the screenshot EXACTLY — pixel-perfect fidelity is the goal
- Pay special attention to: colors, font sizes, spacing, border-radius, shadows
- Use CSS Grid or Flexbox as indicated by the computed styles
- Background images should use the local asset paths
- If the extraction shows SVG content, inline it directly
- Ensure proper viewport meta tag for responsive rendering

Output ONLY the HTML document, no explanations or markdown fences.`
  });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: messageContent
    }]
  });

  let html = response.content[0].text;

  // Clean up if wrapped in code fences
  html = html.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '');

  // Replace any remaining absolute URLs with local asset paths
  for (const [original, local] of Object.entries(assetMap)) {
    html = html.replaceAll(original, local);
  }

  return html;
}

/**
 * Truncate the DOM tree for the Claude API prompt
 */
function truncateTree(node, maxDepth, maxChildren, depth = 0) {
  if (!node || depth > maxDepth) return null;

  const truncated = { ...node };

  if (truncated.children) {
    truncated.children = truncated.children
      .slice(0, maxChildren)
      .map(child => truncateTree(child, maxDepth, maxChildren, depth + 1))
      .filter(Boolean);
  }

  return truncated;
}

/**
 * Send callback to the portal's clone-complete edge function
 */
async function sendCallback(payload) {
  if (!CALLBACK_URL) {
    console.log('   ⚠️ No callback URL configured, skipping');
    return;
  }

  const response = await fetch(CALLBACK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': CLONE_WEBHOOK_SECRET || ''
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Callback failed: ${response.status} ${await response.text()}`);
  }

  console.log(`   ✅ Callback sent successfully`);
}

// Run
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
