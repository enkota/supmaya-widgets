(function () {
  const defaultOptions = {
    iframeSrc: 'https://supmaya.test/agents/1',
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
    stylesInjected: false,
    clickDelegationBound: false,
    autoOpenFired: false,
    scrollLockApplied: false
  };

  const automation = {
    delayTimer: null,
    exitIntentHandler: null,
    scrollHandler: null
  };

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
        background: rgba(15, 23, 42, 0.55);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1.5rem;
        z-index: 2147483000;
        animation: supmaya-fade-in 180ms ease-out;
      }

      .supmaya-popup {
        background: #fff;
        border-radius: 1.25rem;
        box-shadow: 0 30px 70px rgba(15, 23, 42, 0.2);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        position: relative;
        width: min(100%, 480px);
      }

      .supmaya-popup iframe {
        border: none;
        width: 100%;
        height: 100%;
        flex: 1;
      }

      .supmaya-popup button.supmaya-close {
        position: absolute;
        top: 0.65rem;
        right: 0.65rem;
        background: rgba(15, 23, 42, 0.75);
        color: #fff;
        border: none;
        border-radius: 999px;
        width: 34px;
        height: 34px;
        cursor: pointer;
        font-size: 0.9rem;
      }

      .supmaya-popup button.supmaya-close:focus-visible {
        outline: 2px solid #2563eb;
        outline-offset: 2px;
      }

      .supmaya-popup.supmaya-bottom-right {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: auto;
        max-width: 420px;
        border-radius: 1rem;
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
    `;

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

    return opts;
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
    container.style.maxHeight = 'calc(100vh - 32px)';

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'supmaya-close';
    closeButton.setAttribute('aria-label', 'Close popup');
    closeButton.innerHTML = '&times;';
    closeButton.addEventListener('click', close);

    const iframe = document.createElement('iframe');
    iframe.src = options.iframeSrc;
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
    state.autoOpenFired = false;
    whenDomReady(() => {
      ensureStyles();
      bindDelegatedClicks();
      setupTriggers();
    });
    return { ...state.baseOptions };
  }

  function update(options = {}) {
    state.baseOptions = mergeOptions(state.baseOptions, options);
    state.autoOpenFired = false;
    whenDomReady(() => {
      ensureStyles();
      bindDelegatedClicks();
      setupTriggers();
    });
    return { ...state.baseOptions };
  }

  window.SupmayaPopup = {
    init,
    update,
    configure: update,
    open,
    close,
    resetTriggers
  };
})();
