/**
 * DOM Extraction Script
 *
 * Runs inside the browser page context via Playwright's evaluate().
 * Walks the visible DOM and extracts computed styles, text content,
 * and asset references for each element.
 *
 * Inspired by the ai-website-cloner-template's getComputedStyle() approach.
 */

/**
 * Returns a serializable extraction of the visible DOM tree.
 * This function is stringified and injected into the page.
 */
export const extractionScript = () => {
  const STYLE_PROPERTIES = [
    'display', 'position', 'top', 'right', 'bottom', 'left',
    'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
    'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'border', 'borderRadius', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft',
    'backgroundColor', 'color', 'opacity',
    'fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign', 'textDecoration', 'textTransform',
    'flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'alignSelf', 'gap', 'flex', 'flexGrow', 'flexShrink', 'flexBasis',
    'gridTemplateColumns', 'gridTemplateRows', 'gridColumn', 'gridRow', 'gridGap',
    'overflow', 'overflowX', 'overflowY',
    'boxShadow', 'textShadow',
    'transform', 'transition', 'animation',
    'zIndex', 'cursor', 'visibility',
    'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat',
    'objectFit', 'objectPosition',
    'listStyleType', 'listStylePosition',
    'whiteSpace', 'wordBreak', 'overflowWrap'
  ];

  const MAX_DEPTH = 8;
  const MAX_CHILDREN = 50;

  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (style.position === 'fixed' || style.position === 'absolute') return true;
      return false;
    }
    return true;
  }

  function getRelevantStyles(el) {
    const computed = getComputedStyle(el);
    const styles = {};
    for (const prop of STYLE_PROPERTIES) {
      const val = computed[prop];
      if (val && val !== '' && val !== 'none' && val !== 'normal' && val !== 'auto' && val !== '0px' && val !== 'rgba(0, 0, 0, 0)') {
        styles[prop] = val;
      }
    }
    return styles;
  }

  function extractElement(el, depth = 0) {
    if (depth > MAX_DEPTH) return null;
    if (!isVisible(el)) return null;

    const tag = el.tagName.toLowerCase();

    // Skip script, style, noscript, svg internals
    if (['script', 'style', 'noscript', 'link', 'meta'].includes(tag)) return null;

    const node = {
      tag,
      styles: getRelevantStyles(el),
      children: []
    };

    // Extract attributes based on tag
    if (tag === 'img') {
      node.src = el.src;
      node.alt = el.alt || '';
      node.width = el.naturalWidth;
      node.height = el.naturalHeight;
    } else if (tag === 'video') {
      node.src = el.src || el.querySelector('source')?.src;
      node.poster = el.poster;
      node.autoplay = el.autoplay;
      node.loop = el.loop;
      node.muted = el.muted;
    } else if (tag === 'a') {
      node.href = el.href;
    } else if (tag === 'svg') {
      node.svgContent = el.outerHTML;
      return node; // Don't recurse into SVG
    }

    // Extract classes for semantic context
    if (el.className && typeof el.className === 'string') {
      node.classes = el.className.trim();
    }

    // Extract ID if present
    if (el.id) {
      node.id = el.id;
    }

    // Extract text content (direct text nodes only)
    const textContent = Array.from(el.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent.trim())
      .filter(t => t.length > 0)
      .join(' ');

    if (textContent) {
      node.text = textContent;
    }

    // Recurse into children
    const childElements = Array.from(el.children).slice(0, MAX_CHILDREN);
    for (const child of childElements) {
      const extracted = extractElement(child, depth + 1);
      if (extracted) {
        node.children.push(extracted);
      }
    }

    return node;
  }

  // Extract assets
  const assets = {
    images: [...document.querySelectorAll('img')].map(img => ({
      src: img.src,
      alt: img.alt,
      width: img.naturalWidth,
      height: img.naturalHeight
    })).filter(img => img.src && !img.src.startsWith('data:')),

    fonts: (() => {
      const fontUrls = new Set();
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSFontFaceRule) {
              const src = rule.style.getPropertyValue('src');
              const urls = src.match(/url\(["']?([^"')]+)["']?\)/g);
              if (urls) urls.forEach(u => fontUrls.add(u.replace(/url\(["']?|["']?\)/g, '')));
            }
          }
        } catch (e) { /* cross-origin stylesheet */ }
      }
      return [...fontUrls];
    })(),

    backgroundImages: (() => {
      const bgImages = new Set();
      document.querySelectorAll('*').forEach(el => {
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg !== 'none') {
          const urls = bg.match(/url\(["']?([^"')]+)["']?\)/g);
          if (urls) urls.forEach(u => bgImages.add(u.replace(/url\(["']?|["']?\)/g, '')));
        }
      });
      return [...bgImages].filter(u => !u.startsWith('data:'));
    })(),

    videos: [...document.querySelectorAll('video')].map(v => ({
      src: v.src || v.querySelector('source')?.src,
      poster: v.poster
    })).filter(v => v.src),

    favicons: [...document.querySelectorAll('link[rel*="icon"]')].map(l => l.href).filter(Boolean),

    googleFonts: [...document.querySelectorAll('link[href*="fonts.googleapis.com"]')].map(l => l.href)
  };

  // Extract page metadata
  const metadata = {
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.content || '',
    ogImage: document.querySelector('meta[property="og:image"]')?.content || '',
    charset: document.characterSet,
    viewport: document.querySelector('meta[name="viewport"]')?.content || '',
    themeColor: document.querySelector('meta[name="theme-color"]')?.content || ''
  };

  // Extract the body
  const bodyTree = extractElement(document.body);

  return {
    metadata,
    assets,
    bodyTree,
    htmlAttributes: {
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
      classes: document.documentElement.className
    },
    bodyAttributes: {
      classes: document.body.className
    },
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight
  };
};
