(function () {
  const DEFAULT_AGENT_BASE_URL = 'https://supmaya.com/agents/';

  const defaultOptions = {
    iframeSrc: `${DEFAULT_AGENT_BASE_URL}1`,
    agentBaseUrl: DEFAULT_AGENT_BASE_URL,
    agentId: undefined,
    width: 376,
    height: null,
    position: 'center',
    overlay: true,
    closeOnOverlayClick: true,
    triggers: {
      openOnLoad: false,
      delayEnabled: false,
      delaySeconds: null,
      exitIntent: false,
      scrollEnabled: false,
      scrollPercent: null
    }
  };

  const state = {
    baseOptions: { ...defaultOptions },
    domReady: document.readyState !== 'loading',
    readyQueue: [],
    popupEl: null,
    overlayEl: null,
    iframeEl: null,
    isOpen: false,
    escapeKeyHandler: null,
    stylesInjected: false,
    clickDelegationBound: false,
    autoOpenFired: false,
    scrollLockApplied: false,
    standardObserver: null
  };

  const automation = {
    delayTimer: null,
    exitIntentHandler: null,
    scrollHandler: null
  };

  const STANDARD_IFRAME_SELECTOR = 'iframe[data-supmaya-src], iframe[data-supmaya-id]';
  const IFRAME_RESIZER_URL = 'https://cdn.jsdelivr.net/npm/@open-iframe-resizer/core@v2.1.0/dist/index.min.js';
  const processedStandardEmbeds = new WeakSet();
  const dynamicHeightRegistry = new WeakMap();
  let iframeResizerPromise = null;

  if (!state.domReady) {
    document.addEventListener('DOMContentLoaded', () => {
      state.domReady = true;
      const queued = [...state.readyQueue];
      state.readyQueue.length = 0;
      queued.forEach((fn) => fn());
    });
  }

  function whenDomReady(callback) {
    if (state.domReady) {
      callback();
    } else {
      state.readyQueue.push(callback);
    }
  }

  function mergeOptions(base, override = {}) {
    const merged = { ...base, ...override };
    merged.triggers = {
      ...(base.triggers || {}),
      ...(override.triggers || {})
    };
    return merged;
  }

  function normalizeOptions(rawOptions) {
    const options = { ...rawOptions };
    options.iframeSrc = options.iframeSrc || defaultOptions.iframeSrc;
    options.agentId = normalizeAgentId(options.agentId);
    options.agentBaseUrl = normalizeAgentBaseUrl(options.agentBaseUrl ?? defaultOptions.agentBaseUrl) || defaultOptions.agentBaseUrl;

    const width = Number(options.width);
    options.width = Number.isFinite(width) && width > 0 ? width : defaultOptions.width;

    const height = Number(options.height);
    options.height = Number.isFinite(height) && height > 0 ? height : null;

    const allowedPositions = ['center', 'bottom-right'];
    options.position = allowedPositions.includes(options.position) ? options.position : 'center';

    if (!options.height) {
      if (options.position === 'bottom-right') {
        options.height = 520;
      } else {
        const viewportSafe = Math.max(360, Math.min(720, window.innerHeight - 80));
        options.height = viewportSafe;
      }
    }

    options.overlay = options.position === 'center' ? options.overlay !== false : false;
    options.closeOnOverlayClick = options.closeOnOverlayClick !== false;

    options.iframeSrc = resolveIframeSrc(options);

    return options;
  }

  function ensureStyles() {
    if (state.stylesInjected) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'supmaya-popup-styles';
    style.textContent = `
      .supmaya-popup-overlay {
        position: fixed;
        inset: 0;
        background: rgb(15 15 15 / 60%);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1.5rem;
        z-index: 2147483000;
        animation: supmaya-fade-in 180ms ease-out;
      }

      .supmaya-popup {
        background: #fff;
        border-radius: .375rem;
        box-shadow: #0f0f0f0d 0 0 0 1px,#0f0f0f1a 0 3px 6px,#0f0f0f33 0 9px 24px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        position: relative;
        width: min(100%, 480px);
      }

      .supmaya-popup.supmaya-center {
        animation: supmaya-slide-up 200ms ease-out;
      }

      .supmaya-popup iframe {
        border: none;
        width: 100%;
        height: 100%;
        flex: 1;
      }

      .supmaya-popup .supmaya-close {
        position: absolute;
        top: .2rem;
        right: .2rem;
        background: rgb(192 192 192 / 36%);
        color: #707070;
        border: none;
        border-radius: 999px;
        cursor: pointer;
        padding: 2px;
        height: 15px;
        width: 15px;
        cursor: pointer;
        display: flex;
        justify-content: center;
        align-items: center;
      }

      .supmaya-popup .supmaya-close svg{
        width:14px;
        height:14px;
      }

      .supmaya-popup.supmaya-bottom-right {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: auto;
        max-width: 420px;
        border-radius: .375rem;
        animation: supmaya-slide-up 200ms ease-out;
      }

      body.supmaya-popup-locked {
        overflow: hidden;
      }

      @keyframes supmaya-fade-in {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }

      @keyframes supmaya-slide-up {
        from {
          opacity: 0;
          transform: translateY(12px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
    `

    document.head.appendChild(style);
    state.stylesInjected = true;
  }

  function bindDelegatedClicks() {
    if (state.clickDelegationBound) {
      return;
    }

    document.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-supmaya-open]');
      if (!trigger) {
        return;
      }

      event.preventDefault();
      const datasetOptions = datasetToOptions(trigger.dataset);
      open(datasetOptions);
    });

    state.clickDelegationBound = true;
  }

  function datasetToOptions(dataset) {
    const opts = {};

    if (dataset.supmayaSrc) {
      opts.iframeSrc = dataset.supmayaSrc;
    }

    if (dataset.supmayaWidth) {
      const width = Number(dataset.supmayaWidth);
      if (Number.isFinite(width)) {
        opts.width = width;
      }
    }

    if (dataset.supmayaHeight) {
      const height = Number(dataset.supmayaHeight);
      if (Number.isFinite(height)) {
        opts.height = height;
      }
    }

    if (dataset.supmayaPosition) {
      opts.position = dataset.supmayaPosition;
    }

    if (dataset.supmayaOverlay) {
      opts.overlay = dataset.supmayaOverlay !== 'false';
    }

    if (dataset.supmayaId) {
      const id = normalizeAgentId(dataset.supmayaId);
      if (id) {
        opts.agentId = id;
      }
    }

    if (dataset.supmayaBaseUrl) {
      const base = normalizeAgentBaseUrl(dataset.supmayaBaseUrl);
      if (base) {
        opts.agentBaseUrl = base;
      }
    }

    return opts;
  }

  function normalizeAgentId(value) {
    if (value == null) {
      return undefined;
    }

    const trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  function normalizeAgentBaseUrl(value) {
    if (value == null) {
      return undefined;
    }

    const trimmed = String(value).trim();
    if (!trimmed) {
      return undefined;
    }

    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  }

  function deriveAgentBaseUrl(src) {
    if (!src) {
      return '';
    }

    try {
      const url = new URL(src, window.location.href);
      const path = url.pathname;

      if (path.endsWith('/')) {
        url.pathname = path;
      } else {
        const lastSlash = path.lastIndexOf('/');
        url.pathname = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '/';
      }

      return url.toString();
    } catch (error) {
      const normalized = src.replace(/\\/g, '/');
      const lastSlash = normalized.lastIndexOf('/');
      return lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : normalized;
    }
  }

  function buildIframeSrcWithAgentId(baseSrc, agentId) {
    if (!agentId) {
      return baseSrc;
    }

    const base = deriveAgentBaseUrl(baseSrc) || baseSrc;
    try {
      const url = new URL(base, window.location.href);
      const basePath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
      url.pathname = `${basePath}${agentId}`;
      return url.toString();
    } catch (error) {
      const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
      return `${trimmedBase}/${agentId}`;
    }
  }

  function resolveIframeSrc(options) {
    if (!options.agentId) {
      return options.iframeSrc;
    }

    const baseUrl = options.agentBaseUrl || deriveAgentBaseUrl(options.iframeSrc) || options.iframeSrc;
    return buildIframeSrcWithAgentId(baseUrl, options.agentId);
  }

  function setupStandardEmbeds(options = {}) {
    if (!state.domReady) {
      return;
    }

    const iframes = document.querySelectorAll(STANDARD_IFRAME_SELECTOR);
    iframes.forEach((iframe) => enhanceStandardIframe(iframe));

    const shouldObserve = options.observe !== false;
    if (!shouldObserve || state.standardObserver || !window.MutationObserver) {
      return;
    }

    const target = document.body;
    if (!target) {
      return;
    }

    state.standardObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) {
            return;
          }

          if (node.matches(STANDARD_IFRAME_SELECTOR)) {
            enhanceStandardIframe(node);
          }

          if (typeof node.querySelectorAll === 'function') {
            node.querySelectorAll(STANDARD_IFRAME_SELECTOR).forEach((iframe) => enhanceStandardIframe(iframe));
          }
        });
      });
    });

    state.standardObserver.observe(target, { childList: true, subtree: true });
  }

  function enhanceStandardIframe(iframe) {
    if (!(iframe instanceof HTMLIFrameElement) || processedStandardEmbeds.has(iframe)) {
      return;
    }

    const parsed = parseStandardIframeOptions(iframe);
    if (!parsed) {
      return;
    }

    const { url, dynamicHeight, transparentBackground } = parsed;

    iframe.setAttribute('data-supmaya-embed-ready', 'true');
    iframe.setAttribute('src', url.toString());

    if (!iframe.getAttribute('title')) {
      iframe.setAttribute('title', 'Supmaya agent');
    }

    if (!iframe.getAttribute('loading')) {
      iframe.setAttribute('loading', 'lazy');
    }

    if (!iframe.getAttribute('referrerpolicy')) {
      iframe.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
    }

    const requiredAllow = 'microphone; camera; fullscreen; clipboard-write; autoplay';
    const mergedAllow = mergeAllowDirectives(iframe.getAttribute('allow'), requiredAllow);
    iframe.setAttribute('allow', mergedAllow);

    if (transparentBackground) {
      iframe.style.backgroundColor = 'transparent';
      iframe.setAttribute('allowtransparency', 'true');
    }

    if (dynamicHeight) {
      enableDynamicHeight(iframe, url).catch((error) => {
        console.error('SupmayaPopup: failed to enable dynamic height', error);
      });
    }

    processedStandardEmbeds.add(iframe);
  }

  function parseStandardIframeOptions(iframe) {
    if (!iframe.hasAttribute('data-supmaya-src') && !iframe.hasAttribute('data-supmaya-id')) {
      return null;
    }

    const agentId = normalizeAgentId(iframe.dataset?.supmayaId);
    const datasetBaseUrl = normalizeAgentBaseUrl(iframe.dataset?.supmayaBaseUrl);
    const fallbackBase = state.baseOptions?.agentBaseUrl || defaultOptions.agentBaseUrl;
    const suppliedSrc = iframe.dataset?.supmayaSrc || iframe.getAttribute('src');
    const baseForAgent = datasetBaseUrl || suppliedSrc || fallbackBase;
    const resolvedSrc = agentId ? buildIframeSrcWithAgentId(baseForAgent, agentId) : (suppliedSrc || fallbackBase);
    let url;
    try {
      url = new URL(resolvedSrc, window.location.href);
    } catch (error) {
      console.error('SupmayaPopup: invalid iframe src provided', error);
      return null;
    }

    const dynamicHeightAttr = coerceDataFlag(iframe.dataset.supmayaDynamicHeight);
    const transparentAttr = coerceDataFlag(iframe.dataset.supmayaTransparentBackground);

    const hasDynamicQuery = url.searchParams.get('dynamicHeight') === '1';
    const hasTransparentQuery = url.searchParams.get('transparentBackground') === '1';

    const dynamicHeight = dynamicHeightAttr ?? hasDynamicQuery;
    const transparentBackground = transparentAttr ?? hasTransparentQuery;

    if (dynamicHeight && !hasDynamicQuery) {
      url.searchParams.set('dynamicHeight', '1');
    }

    if (transparentBackground && !hasTransparentQuery) {
      url.searchParams.set('transparentBackground', '1');
    }

    return { url, dynamicHeight, transparentBackground };
  }

  function coerceDataFlag(value) {
    if (value == null) {
      return undefined;
    }

    const normalized = String(value).trim().toLowerCase();
    if (!normalized) {
      return true;
    }

    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }

    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }

    return undefined;
  }

  function mergeAllowDirectives(existing, required) {
    if (!existing) {
      return required;
    }

    const directives = new Set();
    existing.split(';').forEach((token) => {
      const trimmed = token.trim();
      if (trimmed) {
        directives.add(trimmed);
      }
    });
    required.split(';').forEach((token) => {
      const trimmed = token.trim();
      if (trimmed) {
        directives.add(trimmed);
      }
    });

    return Array.from(directives).join('; ');
  }

  function enableDynamicHeight(iframe, url) {
    if (dynamicHeightRegistry.has(iframe)) {
      return dynamicHeightRegistry.get(iframe);
    }

    const promise = loadIframeResizer().then(({ initialize, updateParentScrollOnResize }) => {
      if (typeof initialize !== 'function') {
        throw new Error('open-iframe-resizer initialize API unavailable');
      }

      const targetOrigin = url?.origin;
      const checkOrigin = targetOrigin ? [targetOrigin] : true;

      return initialize({
        checkOrigin,
        onIframeResize: typeof updateParentScrollOnResize === 'function' ? updateParentScrollOnResize : undefined
      }, iframe);
    });

    dynamicHeightRegistry.set(iframe, promise);
    return promise;
  }

  function loadIframeResizer() {
    if (!iframeResizerPromise) {
      iframeResizerPromise = import(IFRAME_RESIZER_URL);
    }

    return iframeResizerPromise;
  }

  function clearAutomation() {
    if (automation.delayTimer) {
      clearTimeout(automation.delayTimer);
      automation.delayTimer = null;
    }

    if (automation.exitIntentHandler) {
      document.removeEventListener('mouseout', automation.exitIntentHandler);
      automation.exitIntentHandler = null;
    }

    if (automation.scrollHandler) {
      document.removeEventListener('scroll', automation.scrollHandler);
      automation.scrollHandler = null;
    }
  }

  function setupTriggers() {
    if (!state.domReady) {
      return;
    }

    clearAutomation();
    const triggers = state.baseOptions.triggers || {};

    if (triggers.openOnLoad) {
      window.requestAnimationFrame(() => autoOpen('load'));
    }

    const delayEnabled = triggers.delayEnabled ?? (triggers.delaySeconds != null);
    if (delayEnabled) {
      const delaySeconds = Number(triggers.delaySeconds);
      if (Number.isFinite(delaySeconds) && delaySeconds >= 0) {
        automation.delayTimer = window.setTimeout(() => autoOpen('delay'), delaySeconds * 1000);
      }
    }

    if (triggers.exitIntent) {
      automation.exitIntentHandler = (event) => {
        // Only treat events leaving the root document (body/html) as true exit intent.
        const target = event.target;
        if (!(target === document.documentElement || target === document.body)) {
          return;
        }

        if (event.relatedTarget !== null) {
          return;
        }

        const edgeThreshold = 8; // px from the edge considered "outside"
        const leftEdge = event.clientX <= edgeThreshold;
        const rightEdge = event.clientX >= window.innerWidth - edgeThreshold;
        const topEdge = event.clientY <= edgeThreshold;

        if (topEdge || leftEdge || rightEdge) {
          autoOpen('exit-intent');
        }
      };
      document.addEventListener('mouseout', automation.exitIntentHandler);
    }

    // Only bind scroll trigger if explicitly enabled (falls back to legacy behavior when percent provided)
    const scrollEnabled = triggers.scrollEnabled ?? (triggers.scrollPercent != null);
    if (scrollEnabled) {
      const scrollPercent = Number(triggers.scrollPercent);
      if (Number.isFinite(scrollPercent) && scrollPercent >= 0) {
        const safePercent = Math.min(100, Math.max(0, scrollPercent));
        automation.scrollHandler = () => {
          const doc = document.documentElement;
          const scrollable = doc.scrollHeight - window.innerHeight;
          const current = scrollable <= 0 ? 0 : (window.scrollY / scrollable) * 100;
          if (current >= safePercent) {
            autoOpen('scroll');
          }
        };
        document.addEventListener('scroll', automation.scrollHandler, { passive: true });
        automation.scrollHandler();
      }
    }
  }

  function autoOpen(reason) {
    if (state.autoOpenFired) {
      return;
    }

    state.autoOpenFired = true;
    clearAutomation();
    open();
  }

  function open(customOptions = {}) {
    const normalized = normalizeOptions(mergeOptions(state.baseOptions, customOptions));

    whenDomReady(() => {
      ensureStyles();
      mountPopup(normalized);
    });
  }

  function mountPopup(options) {
    destroyPopup();

    let mountTarget = document.body;

    if (options.overlay) {
      const overlay = document.createElement('div');
      overlay.className = 'supmaya-popup-overlay';
      if (options.closeOnOverlayClick) {
        overlay.addEventListener('click', (event) => {
          if (event.target === overlay) {
            close();
          }
        });
      }
      document.body.appendChild(overlay);
      state.overlayEl = overlay;
      mountTarget = overlay;
      if (!state.scrollLockApplied) {
        document.body.classList.add('supmaya-popup-locked');
        state.scrollLockApplied = true;
      }
    }

    const container = document.createElement('div');
    container.className = `supmaya-popup supmaya-${options.position}`;
    container.setAttribute('role', 'dialog');
    container.setAttribute('aria-modal', String(!!options.overlay));
    container.setAttribute('aria-label', 'Supmaya agent popup');
    container.tabIndex = -1;
    container.style.width = `${options.width}px`;
    container.style.height = `${options.height}px`;
    container.style.maxWidth = 'calc(100% - 32px)';
    container.style.maxHeight = 'calc(350px - 32px)';

    const closeButton = document.createElement('div');
    closeButton.type = 'div';
    closeButton.className = 'supmaya-close';
    closeButton.setAttribute('aria-label', 'Close popup');
    closeButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="size-5"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>';
    closeButton.addEventListener('click', close);

    const iframe = document.createElement('iframe');
    iframe.src = resolveIframeSrc(options);
    iframe.title = 'Supmaya agent';
    iframe.loading = 'lazy';
    iframe.referrerPolicy = 'no-referrer-when-downgrade';
    iframe.allow = 'microphone; camera; fullscreen; clipboard-write; autoplay';

    container.appendChild(closeButton);
    container.appendChild(iframe);

    mountTarget.appendChild(container);

    state.popupEl = container;
    state.iframeEl = iframe;
    state.isOpen = true;

    // Add Escape key handler to allow closing the popup with the Esc key.
    if (!state.escapeKeyHandler) {
      state.escapeKeyHandler = (event) => {
        const key = event?.key || (event && event.keyIdentifier) || null;
        if (key === 'Escape' || key === 'Esc' || event.keyCode === 27) {
          close();
        }
      };
      document.addEventListener('keydown', state.escapeKeyHandler);
    }

    window.requestAnimationFrame(() => {
      container.focus();
    });
  }

  function close() {
    destroyPopup();
  }

  function destroyPopup() {
    if (state.popupEl) {
      state.popupEl.remove();
      state.popupEl = null;
    }

    if (state.overlayEl) {
      state.overlayEl.remove();
      state.overlayEl = null;
    }

    // Remove Escape key handler if it was attached.
    if (state.escapeKeyHandler) {
      document.removeEventListener('keydown', state.escapeKeyHandler);
      state.escapeKeyHandler = null;
    }

    if (state.scrollLockApplied) {
      document.body.classList.remove('supmaya-popup-locked');
      state.scrollLockApplied = false;
    }

    state.isOpen = false;
    state.iframeEl = null;
  }

  function resetTriggers() {
    state.autoOpenFired = false;
    whenDomReady(() => {
      setupTriggers();
    });
  }

  function init(options = {}) {
    state.baseOptions = mergeOptions(defaultOptions, options);
    state.baseOptions.agentBaseUrl = normalizeAgentBaseUrl(state.baseOptions.agentBaseUrl ?? defaultOptions.agentBaseUrl) || defaultOptions.agentBaseUrl;
    state.autoOpenFired = false;
    whenDomReady(() => {
      ensureStyles();
      bindDelegatedClicks();
      setupTriggers();
      setupStandardEmbeds();
    });
    return { ...state.baseOptions };
  }

  function update(options = {}) {
    state.baseOptions = mergeOptions(state.baseOptions, options);
    state.baseOptions.agentBaseUrl = normalizeAgentBaseUrl(state.baseOptions.agentBaseUrl ?? defaultOptions.agentBaseUrl) || defaultOptions.agentBaseUrl;
    state.autoOpenFired = false;
    whenDomReady(() => {
      ensureStyles();
      bindDelegatedClicks();
      setupTriggers();
      setupStandardEmbeds();
    });
    return { ...state.baseOptions };
  }

  function refreshEmbeds() {
    whenDomReady(() => {
      setupStandardEmbeds({ observe: false });
    });
  }

  whenDomReady(() => {
    setupStandardEmbeds();
    // Auto-bind click delegation so a page only needs to include the
    // script and use `data-supmaya-open` on a button to open the popup.
    bindDelegatedClicks();
  });

  window.SupmayaPopup = {
    init,
    update,
    configure: update,
    open,
    close,
    resetTriggers,
    refreshEmbeds
  };
})();
