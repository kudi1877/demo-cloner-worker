/**
 * overlay-inject.mjs
 *
 * Injects a floating demo button into the cloned HTML.
 * The button matches the demo portal's existing overlay style.
 */

/**
 * Inject demo overlay into HTML string
 * @param {string} html - The cloned website HTML
 * @param {object} config - Demo overlay configuration
 * @param {string} config.buttonLabel - Button text (default: "Start Demo")
 * @param {string} config.buttonColor - Button background color (default: "#6366f1")
 * @param {string} config.actionUrl - URL to redirect when clicked
 * @param {string} config.position - Button position: "bottom-right" | "bottom-left" | "bottom-center"
 * @param {string} config.demoId - Demo ID for tracking
 * @returns {string} HTML with overlay injected
 */
export function injectOverlay(html, config = {}) {
  const {
    buttonLabel = 'Start Demo',
    buttonColor = '#6366f1',
    actionUrl = '',
    position = 'bottom-right',
    demoId = ''
  } = config;

  const positionStyles = {
    'bottom-right': 'bottom: 24px; right: 24px;',
    'bottom-left': 'bottom: 24px; left: 24px;',
    'bottom-center': 'bottom: 24px; left: 50%; transform: translateX(-50%);'
  };

  const posStyle = positionStyles[position] || positionStyles['bottom-right'];

  const overlayScript = `
<!-- Demo Overlay - Injected by demo-cloner-worker -->
<style>
  .demo-overlay-btn {
    position: fixed;
    ${posStyle}
    z-index: 999999;
    padding: 14px 28px;
    background: ${buttonColor};
    color: white;
    border: none;
    border-radius: 12px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25), 0 0 0 0 rgba(99, 102, 241, 0.4);
    transition: all 0.2s ease;
    animation: demo-pulse 2s infinite;
    letter-spacing: 0.01em;
  }
  .demo-overlay-btn:hover {
    transform: translateY(-2px) ${position === 'bottom-center' ? 'translateX(-50%)' : ''};
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
  }
  .demo-overlay-btn:active {
    transform: translateY(0) ${position === 'bottom-center' ? 'translateX(-50%)' : ''};
  }
  @keyframes demo-pulse {
    0%, 100% { box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25), 0 0 0 0 rgba(99, 102, 241, 0.4); }
    50% { box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25), 0 0 0 8px rgba(99, 102, 241, 0); }
  }
  .demo-overlay-badge {
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 999998;
    padding: 6px 12px;
    background: rgba(0, 0, 0, 0.7);
    color: white;
    border-radius: 6px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    pointer-events: none;
  }
</style>
<div class="demo-overlay-badge">Interactive Demo</div>
<button class="demo-overlay-btn" onclick="handleDemoClick()" aria-label="${buttonLabel}">
  ${buttonLabel}
</button>
<script>
  function handleDemoClick() {
    const actionUrl = '${actionUrl}';
    const demoId = '${demoId}';

    // If inside an iframe, send message to parent
    if (window.parent !== window) {
      window.parent.postMessage({
        type: 'demo-overlay-click',
        demoId: demoId,
        actionUrl: actionUrl
      }, '*');
    } else if (actionUrl) {
      window.location.href = actionUrl;
    }
  }
</script>
<!-- End Demo Overlay -->`;

  // Inject before </body>
  if (html.includes('</body>')) {
    return html.replace('</body>', overlayScript + '\n</body>');
  }

  // Fallback: append to end
  return html + overlayScript;
}
