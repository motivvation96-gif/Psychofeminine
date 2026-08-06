/* =============================================================================
   PsychoFéminine — app.js
   Logique frontend complète : catalogue Notion, recherche/filtres, modales
   (capture email, vidéo libre, déblocage PDF avec règle des 30 secondes),
   thèmes, menu, preuve sociale dynamique, toasts.
   Aucune clé API Notion ici : tout passe par le Worker Hono (/api/*).
   ============================================================================= */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------- */
  /* CONSTANTES & ÉTAT GLOBAL                                               */
  /* ---------------------------------------------------------------------- */
  var REQUIRED_WATCH_SECONDS = 30;
  var THEME_STORAGE_KEY = 'theme';
  var USER_EMAIL_KEY = 'user_email';
  var STATS_API_URL = 'https://soft-base-2fc9.motivation96.workers.dev/api/stats';
  var DEFAULT_REGISTERED_COUNT = 1200;

  var state = {
    items: [],
    filteredItems: [],
    activeThematique: 'Tous',
    searchQuery: '',
    pendingCard: null, // carte en attente de déblocage après capture email
    currentUnlockCard: null,
    unlockedPageIds: new Set(), // déblocages déjà validés dans cette session (30s déjà atteintes)
    ytApiReady: false,
    ytApiReadyQueue: [],
    catalogPlayer: null,
    unlockPlayer: null,
    watchSeconds: 0,
    watchIntervalId: null,
    captureFormObserver: null,
    captureFormLoadCount: 0,
  };

  /* ---------------------------------------------------------------------- */
  /* RÉFÉRENCES DOM                                                         */
  /* ---------------------------------------------------------------------- */
  var el = {}; // rempli dans cacheDom()

  function cacheDom() {
    el.headerCounterText = document.getElementById('header-counter-text');
    el.socialProofText = document.getElementById('social-proof-text');
    el.statCount = document.getElementById('stat-count');

    el.searchInput = document.getElementById('search-input');
    el.searchClearBtn = document.getElementById('search-clear-btn');
    el.filtersBar = document.getElementById('filters-bar');
    el.cardsGrid = document.getElementById('cards-grid');
    el.emptyState = document.getElementById('empty-state');
    el.errorState = document.getElementById('error-state');
    el.errorMessage = document.getElementById('error-message');
    el.retryBtn = document.getElementById('retry-btn');

    el.themeSwitcherBtn = document.getElementById('theme-switcher-btn');
    el.themeSwitcherDropdown = document.getElementById('theme-switcher-dropdown');
    el.themeOptions = document.querySelectorAll('.theme-option');

    el.headerMenuBtn = document.getElementById('header-menu-btn');
    el.headerMenuDropdown = document.getElementById('header-menu-dropdown');
    el.headerMenuCoaching = document.getElementById('header-menu-coaching');
    el.headerMenuFormations = document.getElementById('header-menu-formations');
    el.headerMenuLogin = document.getElementById('header-menu-login');

    el.captureModal = document.getElementById('capture-modal');
    el.modalCloseBtn = document.getElementById('modal-close-btn');
    el.modalFormWrapper = document.getElementById('modal-form-wrapper');

    el.videoModal = document.getElementById('video-modal');
    el.videoModalCloseBtn = document.getElementById('video-modal-close-btn');
    el.videoModalTitle = document.getElementById('video-modal-title');

    el.unlockModal = document.getElementById('unlock-modal');
    el.unlockModalCloseBtn = document.getElementById('unlock-modal-close-btn');
    el.pdfVolumeBadge = document.getElementById('pdf-volume-badge');
    el.unlockModalTitle = document.getElementById('unlock-modal-title');
    el.watchProgressFill = document.getElementById('watch-progress-fill');
    el.watchProgressLabel = document.getElementById('watch-progress-label');
    el.pdfDirectLink = document.getElementById('pdf-direct-link');
    el.recommendedGuideBtn = document.getElementById('recommended-guide-btn');
    el.recommendedGuideLabel = document.getElementById('recommended-guide-label');
    el.youtubeCtaBtn = document.getElementById('youtube-cta-btn');
    el.unlockCoachingBtn = document.getElementById('unlock-coaching-btn');

    el.watchWarningModal = document.getElementById('watch-warning-modal');
    el.watchWarningCloseBtn = document.getElementById('watch-warning-close-btn');
    el.watchWarningOkBtn = document.getElementById('watch-warning-ok-btn');

    el.toastContainer = document.getElementById('toast-container');
  }

  /* ---------------------------------------------------------------------- */
  /* UTILITAIRES GÉNÉRIQUES                                                 */
  /* ---------------------------------------------------------------------- */
  function debounce(fn, delay) {
    var t = null;
    return function () {
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () {
        fn.apply(null, args);
      }, delay);
    };
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeForSearch(str) {
    if (!str) return '';
    return String(str)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function formatNumberFr(n) {
    try {
      return n.toLocaleString('fr-FR');
    } catch (e) {
      return String(n);
    }
  }

  function smoothScrollToId(id) {
    var target = document.getElementById(id);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* TOAST NOTIFICATIONS                                                    */
  /* ---------------------------------------------------------------------- */
  var TOAST_ICONS = {
    success: 'fa-solid fa-circle-check',
    error: 'fa-solid fa-circle-exclamation',
    info: 'fa-solid fa-circle-info',
  };

  function showToast(message, type) {
    type = type || 'info';
    if (!el.toastContainer) return;
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    var icon = document.createElement('i');
    icon.className = TOAST_ICONS[type] || TOAST_ICONS.info;
    var span = document.createElement('span');
    span.textContent = message;
    toast.appendChild(icon);
    toast.appendChild(span);
    el.toastContainer.appendChild(toast);

    requestAnimationFrame(function () {
      toast.classList.add('is-visible');
    });

    var removeAfter = 4200;
    setTimeout(function () {
      toast.classList.add('is-leaving');
      toast.classList.remove('is-visible');
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, removeAfter);
  }

  /* ---------------------------------------------------------------------- */
  /* SESSION UTILISATEUR (LocalStorage)                                     */
  /* ---------------------------------------------------------------------- */
  function isUserRegistered() {
    try {
      return !!localStorage.getItem(USER_EMAIL_KEY);
    } catch (e) {
      return false;
    }
  }

  function markUserRegistered() {
    try {
      localStorage.setItem(USER_EMAIL_KEY, 'verified_' + Date.now());
    } catch (e) {
      /* localStorage indisponible (mode privé strict) : on continue sans persistance */
    }
  }

  /* ---------------------------------------------------------------------- */
  /* THÈME (Sombre / Clair / Intermédiaire)                                 */
  /* ---------------------------------------------------------------------- */
  function getCurrentTheme() {
    try {
      return localStorage.getItem(THEME_STORAGE_KEY) || 'dark';
    } catch (e) {
      return 'dark';
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (e) {
      /* ignore */
    }
    el.themeOptions.forEach(function (opt) {
      opt.classList.toggle('active', opt.getAttribute('data-theme-value') === theme);
    });
  }

  function initThemeSwitcher() {
    applyTheme(getCurrentTheme());

    if (!el.themeSwitcherBtn || !el.themeSwitcherDropdown) return;

    initDropdownVisibility(el.themeSwitcherDropdown);

    // Même correctif anti-clignotement que le menu burger : stopPropagation
    // empêche le listener global `document click -> closeAllDropdowns()`
    // de refermer le dropdown sur le MÊME clic qui vient de l'ouvrir.
    el.themeSwitcherBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = el.themeSwitcherDropdown.classList.contains('is-open');
      closeAllDropdowns();
      if (!isOpen) openDropdown(el.themeSwitcherDropdown, el.themeSwitcherBtn);
    });

    el.themeSwitcherDropdown.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    el.themeOptions.forEach(function (opt) {
      opt.addEventListener('click', function () {
        applyTheme(opt.getAttribute('data-theme-value'));
        closeAllDropdowns();
      });
    });
  }

  /* ---------------------------------------------------------------------- */
  /* MENU DÉROULANT HEADER (☰) + SWITCHER — helpers communs                 */
  /* ---------------------------------------------------------------------- */
  /* CORRECTIF ANTI-CLIGNOTEMENT :
     Auparavant, la fermeture retirait 'is-open' PUIS remettait 'hidden'
     (display:none) 180ms plus tard via setTimeout, tandis que l'ouverture
     retirait 'hidden' PUIS ajoutait 'is-open' au frame suivant via rAF.
     En cas de clics rapprochés (ou de double déclenchement d'évènement),
     ces deux minuteries concurrentes pouvaient se chevaucher et remettre
     'hidden' juste après l'ouverture -> effet de "clignotement".
     Correctif : on ne touche plus JAMAIS à la classe 'hidden' après
     l'initialisation (elle ne servait qu'au rendu SSR initial). La visibilité
     est intégralement pilotée par la seule classe '.is-open' (opacity +
     pointer-events déjà gérés en CSS), sans aucun setTimeout ni rAF donc
     sans race condition possible. */
  function initDropdownVisibility(dropdownEl) {
    if (dropdownEl) dropdownEl.classList.remove('hidden');
  }

  function openDropdown(dropdownEl, btnEl) {
    if (!dropdownEl) return;
    dropdownEl.classList.add('is-open');
    if (btnEl) btnEl.setAttribute('aria-expanded', 'true');
  }

  function closeDropdown(dropdownEl, btnEl) {
    if (!dropdownEl) return;
    dropdownEl.classList.remove('is-open');
    if (btnEl) btnEl.setAttribute('aria-expanded', 'false');
  }

  function closeAllDropdowns() {
    closeDropdown(el.themeSwitcherDropdown, el.themeSwitcherBtn);
    closeDropdown(el.headerMenuDropdown, el.headerMenuBtn);
  }

  function initHeaderMenu() {
    if (!el.headerMenuBtn || !el.headerMenuDropdown) return;

    initDropdownVisibility(el.headerMenuDropdown);

    // e.stopPropagation() est IMPÉRATIF ici : sans lui, le clic remonte
    // (bubbling) jusqu'au listener global posé sur `document` (voir plus
    // bas) qui referme IMMÉDIATEMENT tout ce qu'on vient d'ouvrir sur ce
    // même clic -> c'est l'exacte cause du clignotement observé.
    el.headerMenuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = el.headerMenuDropdown.classList.contains('is-open');
      closeAllDropdowns();
      if (!isOpen) openDropdown(el.headerMenuDropdown, el.headerMenuBtn);
    });

    // Empêche aussi le clic à l'intérieur du menu déroulant lui-même de
    // se propager jusqu'à `document` et de fermer le menu avant que le
    // lien/bouton cliqué n'ait eu le temps de réagir.
    el.headerMenuDropdown.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    // 1. Coaching Privé : reste sur la page, scroll fluide vers #formules.
    if (el.headerMenuCoaching) {
      el.headerMenuCoaching.addEventListener('click', function () {
        closeAllDropdowns();
        smoothScrollToId('formules');
      });
    }

    // 2. Formations : lien externe natif (target=_blank), on ferme juste le menu.
    if (el.headerMenuFormations) {
      el.headerMenuFormations.addEventListener('click', function () {
        closeAllDropdowns();
      });
    }

    // 3. Se connecter : vérifie la session localStorage.
    if (el.headerMenuLogin) {
      el.headerMenuLogin.addEventListener('click', function () {
        closeAllDropdowns();
        if (isUserRegistered()) {
          showToast('Vous êtes déjà connecté.', 'info');
          smoothScrollToId('catalog-section');
        } else {
          state.pendingCard = null; // pas de carte en attente : simple connexion
          openCaptureModal();
        }
      });
    }

    // Fermeture au clic à l'extérieur (seul cas légitime de fermeture
    // automatique, sans jamais interférer avec l'ouverture elle-même
    // grâce aux stopPropagation() ci-dessus).
    document.addEventListener('click', function () {
      closeAllDropdowns();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeAllDropdowns();
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* PREUVE SOCIALE DYNAMIQUE — compteur d'inscrits                        */
  /* ---------------------------------------------------------------------- */
  function loadSocialProofStats() {
    if (!el.socialProofText) return;

    var controller = null;
    var timeoutId = null;
    try {
      controller = new AbortController();
      timeoutId = setTimeout(function () {
        controller.abort();
      }, 4000);
    } catch (e) {
      /* AbortController indisponible : on continue sans timeout */
    }

    fetch(STATS_API_URL, controller ? { signal: controller.signal } : {})
      .then(function (res) {
        if (!res.ok) throw new Error('stats http ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var total = data && (data.totalContacts || data.total_contacts || data.total || data.contacts);
        var count = Number.isFinite(Number(total)) && Number(total) > 0 ? Number(total) : DEFAULT_REGISTERED_COUNT;
        renderSocialProofCount(count);
      })
      .catch(function () {
        renderSocialProofCount(DEFAULT_REGISTERED_COUNT);
      })
      .finally(function () {
        if (timeoutId) clearTimeout(timeoutId);
      });
  }

  function renderSocialProofCount(count) {
    el.socialProofText.innerHTML =
      '<i class="fa-solid fa-users"></i> +' + formatNumberFr(count) + ' hommes et femmes déjà inscrits';
  }

  /* ---------------------------------------------------------------------- */
  /* MAPPING NOTION CÔTÉ CLIENT (format natif /api/notion)                  */
  /* ---------------------------------------------------------------------- */
  function normalizeKey(key) {
    return key.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function resolvePropertyKey(properties, candidates) {
    var map = {};
    Object.keys(properties).forEach(function (k) {
      map[normalizeKey(k)] = k;
    });
    for (var i = 0; i < candidates.length; i++) {
      var found = map[normalizeKey(candidates[i])];
      if (found) return found;
    }
    return null;
  }

  function getTitleText(properties, candidates) {
    var key = resolvePropertyKey(properties, candidates);
    if (!key) return null;
    var prop = properties[key];
    if (!prop || prop.type !== 'title' || !Array.isArray(prop.title)) return null;
    var text = prop.title.map(function (t) { return t.plain_text || ''; }).join('').trim();
    return text || null;
  }

  function getUrlText(properties, candidates) {
    for (var i = 0; i < candidates.length; i++) {
      var key = resolvePropertyKey(properties, [candidates[i]]);
      if (!key) continue;
      var prop = properties[key];
      if (!prop) continue;
      if (prop.type === 'url' && prop.url) return prop.url.trim();
      if (prop.type === 'rich_text' && Array.isArray(prop.rich_text) && prop.rich_text.length) {
        var t = prop.rich_text.map(function (x) { return x.plain_text || ''; }).join('').trim();
        if (t) return t;
      }
    }
    return null;
  }

  function getRichText(properties, candidates) {
    var key = resolvePropertyKey(properties, candidates);
    if (!key) return null;
    var prop = properties[key];
    if (!prop) return null;
    if (prop.type === 'rich_text' && Array.isArray(prop.rich_text)) {
      var t = prop.rich_text.map(function (x) { return x.plain_text || ''; }).join('').trim();
      return t || null;
    }
    if (prop.type === 'number' && prop.number != null) return String(prop.number);
    return null;
  }

  function getSelectOrStatus(properties, candidates) {
    var key = resolvePropertyKey(properties, candidates);
    if (!key) return null;
    var prop = properties[key];
    if (!prop) return null;
    if (prop.type === 'select') return prop.select ? prop.select.name || null : null;
    if (prop.type === 'status') return prop.status ? prop.status.name || null : null;
    return null;
  }

  function hasFiles(properties, candidates) {
    var key = resolvePropertyKey(properties, candidates);
    if (!key) return false;
    var prop = properties[key];
    if (!prop) return false;
    if (prop.type === 'files') return Array.isArray(prop.files) && prop.files.length > 0;
    if (prop.type === 'url') return !!prop.url;
    return false;
  }

  function extractYouTubeId(url) {
    if (!url) return null;
    try {
      var u = new URL(url);
      var host = u.hostname.replace(/^www\./, '');
      if (host === 'youtu.be') {
        return u.pathname.replace(/^\//, '').split('/')[0] || null;
      }
      if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
        if (u.pathname === '/watch') return u.searchParams.get('v');
        if (u.pathname.indexOf('/embed/') === 0) return u.pathname.split('/embed/')[1].split('/')[0] || null;
        if (u.pathname.indexOf('/shorts/') === 0) return u.pathname.split('/shorts/')[1].split('/')[0] || null;
      }
    } catch (e) {
      /* URL invalide */
    }
    return null;
  }

  function extractVolumeNumber(text) {
    if (!text) return null;
    var m = text.match(/(\d+)/);
    if (!m) return null;
    var n = parseInt(m[1], 10);
    return isNaN(n) ? null : n;
  }

  var PROP_CANDIDATES = {
    titre: ['TITRE', 'Titre'],
    statut: ['Statut', 'Status'],
    thematique: ['Thématique', 'Thematique'],
    volume: ['Volume'],
    videoUrl: ['Liens Vidéos YouTube', 'Lien YouTube', 'Lien Vidéo YouTube'],
    guideUrl: ['Lien du Guide Recommandé', 'Lien Guide Recommandé'],
    prixGuide: ['Prix Guide Recommandé', 'Prix du Guide Recommandé'],
    fichierPdf: ['Fichier PDF', 'PDF'],
  };

  function mapRawItemToCard(item) {
    var properties = item.properties || {};
    var titre = getTitleText(properties, PROP_CANDIDATES.titre) || 'Sans titre';
    var statut = getSelectOrStatus(properties, PROP_CANDIDATES.statut);
    var thematique = getSelectOrStatus(properties, PROP_CANDIDATES.thematique);
    var volumeLabel = getRichText(properties, PROP_CANDIDATES.volume);
    var videoUrl = getUrlText(properties, PROP_CANDIDATES.videoUrl);
    var guideUrl = getUrlText(properties, PROP_CANDIDATES.guideUrl);
    var prixGuideRecommande = getRichText(properties, PROP_CANDIDATES.prixGuide);
    var hasPdf = hasFiles(properties, PROP_CANDIDATES.fichierPdf);
    var videoId = extractYouTubeId(videoUrl);

    return {
      pageId: item.id,
      titre: titre,
      resolvedTitle: titre, // remplacé par le titre YouTube oEmbed dès disponible
      statut: statut,
      thematique: thematique,
      volumeLabel: volumeLabel,
      volumeNumber: extractVolumeNumber(volumeLabel),
      videoUrl: videoUrl,
      videoId: videoId,
      guideUrl: guideUrl,
      prixGuideRecommande: prixGuideRecommande,
      hasPdf: hasPdf,
      isNew: false,
    };
  }

  function isPublishedCard(card) {
    return (card.statut || '').trim().toLowerCase() === 'publié';
  }

  /* ---------------------------------------------------------------------- */
  /* CHARGEMENT DU CATALOGUE                                                */
  /* ---------------------------------------------------------------------- */
  function loadCatalog() {
    showSkeletons();
    hide(el.errorState);
    hide(el.emptyState);

    fetch('/api/notion')
      .then(function (res) {
        if (!res.ok) throw new Error('http_' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (data && data.error) throw new Error(data.error);
        var results = data && (data.results || data) || [];
        if (!Array.isArray(results)) results = [];

        var cards = results.map(mapRawItemToCard).filter(isPublishedCard);

        cards.sort(function (a, b) {
          var av = a.volumeNumber == null ? -Infinity : a.volumeNumber;
          var bv = b.volumeNumber == null ? -Infinity : b.volumeNumber;
          if (av !== bv) return bv - av;
          return a.titre.localeCompare(b.titre);
        });
        cards.forEach(function (c, idx) {
          c.isNew = idx < 4;
        });

        state.items = cards;
        state.filteredItems = cards;

        renderFilters();
        renderGrid();
        updateCounters();
        resolveYouTubeTitles();
      })
      .catch(function (err) {
        console.error(err);
        showError('Impossible de charger le catalogue depuis Notion. Merci de réessayer.');
      });
  }

  function showSkeletons() {
    // Les squelettes HTML sont déjà présents côté serveur au premier rendu ;
    // on ne les régénère qu'en cas de rechargement manuel (bouton Réessayer).
    if (el.cardsGrid.querySelector('.card-skeleton')) return;
    var html = '';
    for (var i = 0; i < 8; i++) {
      html +=
        '<div class="card card-skeleton">' +
        '<div class="skeleton-thumb"></div>' +
        '<div class="card-body">' +
        '<div class="skeleton-line skeleton-line-title"></div>' +
        '<div class="skeleton-line skeleton-line-tag"></div>' +
        '<div class="skeleton-actions-row"><div class="skeleton-btn"></div><div class="skeleton-btn"></div></div>' +
        '</div></div>';
    }
    el.cardsGrid.innerHTML = html;
  }

  function showError(message) {
    el.cardsGrid.innerHTML = '';
    el.errorMessage.textContent = message;
    show(el.errorState);
  }

  function hide(node) {
    if (node) node.classList.add('hidden');
  }
  function show(node) {
    if (node) node.classList.remove('hidden');
  }

  /* ---------------------------------------------------------------------- */
  /* COMPTEURS DYNAMIQUES (header banner + hero stat)                       */
  /* ---------------------------------------------------------------------- */
  function updateCounters() {
    var count = state.items.length;
    if (el.headerCounterText) {
      var label = count === 1 ? 'résumé PDF disponible' : 'résumés PDF disponibles';
      el.headerCounterText.textContent = count + ' ' + label;
    }
    if (el.statCount) {
      el.statCount.textContent = String(count);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* FILTRES PAR THÉMATIQUE + RECHERCHE EN TEMPS RÉEL                       */
  /* ---------------------------------------------------------------------- */
  function renderFilters() {
    if (!el.filtersBar) return;
    var thematiques = [];
    state.items.forEach(function (c) {
      if (c.thematique && thematiques.indexOf(c.thematique) === -1) thematiques.push(c.thematique);
    });
    thematiques.sort(function (a, b) {
      return a.localeCompare(b);
    });

    var chips = ['Tous'].concat(thematiques);
    el.filtersBar.innerHTML = chips
      .map(function (t) {
        var active = t === state.activeThematique ? ' active' : '';
        return (
          '<button type="button" class="filter-chip' +
          active +
          '" data-filter="' +
          escapeHtml(t) +
          '">' +
          escapeHtml(t) +
          '</button>'
        );
      })
      .join('');

    Array.prototype.forEach.call(el.filtersBar.querySelectorAll('.filter-chip'), function (btn) {
      btn.addEventListener('click', function () {
        state.activeThematique = btn.getAttribute('data-filter');
        Array.prototype.forEach.call(el.filtersBar.querySelectorAll('.filter-chip'), function (b) {
          b.classList.toggle('active', b === btn);
        });
        applyFilters();
      });
    });
  }

  function applyFilters() {
    var q = normalizeForSearch(state.searchQuery);
    state.filteredItems = state.items.filter(function (card) {
      var matchesTheme = state.activeThematique === 'Tous' || card.thematique === state.activeThematique;
      if (!matchesTheme) return false;
      if (!q) return true;
      var haystack = normalizeForSearch((card.resolvedTitle || card.titre) + ' ' + (card.thematique || ''));
      return haystack.indexOf(q) !== -1;
    });
    renderGrid();
  }

  function initSearch() {
    if (!el.searchInput) return;
    var onInput = debounce(function () {
      state.searchQuery = el.searchInput.value || '';
      el.searchClearBtn.classList.toggle('hidden', !state.searchQuery);
      applyFilters();
    }, 150);
    el.searchInput.addEventListener('input', onInput);

    if (el.searchClearBtn) {
      el.searchClearBtn.addEventListener('click', function () {
        el.searchInput.value = '';
        state.searchQuery = '';
        el.searchClearBtn.classList.add('hidden');
        applyFilters();
        el.searchInput.focus();
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* RENDU DE LA GRILLE DE CARTES                                           */
  /* ---------------------------------------------------------------------- */
  function renderGrid() {
    var items = state.filteredItems;

    if (state.items.length === 0) {
      el.cardsGrid.innerHTML = '';
      hide(el.errorState);
      show(el.emptyState);
      return;
    }

    hide(el.errorState);

    if (items.length === 0) {
      el.cardsGrid.innerHTML = '';
      el.emptyState.querySelector('p').textContent = 'Aucun résultat pour cette recherche/filtre.';
      show(el.emptyState);
      return;
    }

    hide(el.emptyState);
    el.cardsGrid.innerHTML = items.map(renderCardHtml).join('');

    Array.prototype.forEach.call(el.cardsGrid.querySelectorAll('.card'), function (cardEl) {
      var pageId = cardEl.getAttribute('data-page-id');
      var card = findCardByPageId(pageId);
      if (!card) return;

      var thumbImg = cardEl.querySelector('.card-thumb');
      if (thumbImg) {
        var triedHq = false;
        thumbImg.addEventListener('error', function () {
          if (!triedHq && card.videoId) {
            triedHq = true;
            thumbImg.src = 'https://img.youtube.com/vi/' + card.videoId + '/hqdefault.jpg';
          }
        });
      }

      var watchBtn = cardEl.querySelector('.js-watch-btn');
      if (watchBtn) {
        watchBtn.addEventListener('click', function () {
          openFreeVideoModal(card);
        });
      }

      var unlockBtn = cardEl.querySelector('.js-unlock-btn');
      if (unlockBtn) {
        unlockBtn.addEventListener('click', function () {
          handleUnlockRequest(card);
        });
      }
    });
  }

  function findCardByPageId(pageId) {
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].pageId === pageId) return state.items[i];
    }
    return null;
  }

  function renderCardHtml(card) {
    var thumbHtml;
    if (card.videoId) {
      thumbHtml =
        '<img class="card-thumb" loading="lazy" alt="' +
        escapeHtml(card.resolvedTitle || card.titre) +
        '" src="https://img.youtube.com/vi/' +
        card.videoId +
        '/maxresdefault.jpg" />' +
        '<button type="button" class="card-thumb-play-btn js-watch-btn" aria-label="Regarder la vidéo"><i class="fa-solid fa-play"></i></button>';
    } else {
      thumbHtml =
        '<div class="card-thumb-placeholder" style="position:absolute;inset:0;display:grid;place-items:center;">' +
        '<i class="fa-solid fa-video-slash card-thumb-placeholder-icon"></i></div>';
    }

    var volumeBadgeHtml = card.volumeLabel
      ? '<span class="volume-badge card-badge-overlay-left"><i class="fa-solid fa-layer-group"></i>' +
        escapeHtml(card.volumeLabel) +
        '</span>'
      : '';
    var newBadgeHtml = card.isNew
      ? '<span class="new-badge card-badge-overlay-right"><i class="fa-solid fa-sparkles"></i>NEW</span>'
      : '';

    var tagsHtml = card.thematique
      ? '<div class="card-tags"><span class="tag-chip">' + escapeHtml(card.thematique) + '</span></div>'
      : '';

    return (
      '<div class="card" data-page-id="' +
      escapeHtml(card.pageId) +
      '">' +
      '<div class="card-thumb-wrapper">' +
      thumbHtml +
      volumeBadgeHtml +
      newBadgeHtml +
      '</div>' +
      '<div class="card-body">' +
      '<h3 class="card-title js-card-title">' +
      escapeHtml(card.resolvedTitle || card.titre) +
      '</h3>' +
      tagsHtml +
      '<div class="card-spacer"></div>' +
      '<div class="card-actions-row">' +
      '<button type="button" class="btn btn-card-watch js-watch-btn"' +
      (card.videoId ? '' : ' disabled') +
      '><i class="fa-solid fa-play"></i><span>Regarder la vidéo</span></button>' +
      '<button type="button" class="btn btn-unlock js-unlock-btn"><i class="fa-solid fa-lock"></i><span>Débloquer le résumé PDF</span></button>' +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  /* ---------------------------------------------------------------------- */
  /* TITRES DYNAMIQUES YOUTUBE (oEmbed via proxy serveur)                    */
  /* ---------------------------------------------------------------------- */
  function resolveYouTubeTitles() {
    state.items.forEach(function (card) {
      if (!card.videoId) return;
      fetch('/api/youtube-meta/' + encodeURIComponent(card.videoId))
        .then(function (res) {
          return res.ok ? res.json() : { title: null };
        })
        .then(function (data) {
          if (data && data.title) {
            card.resolvedTitle = data.title;
            updateCardTitleInDom(card);
          }
        })
        .catch(function () {
          /* silencieux : repli déjà en place (TITRE Notion) */
        });
    });
  }

  function updateCardTitleInDom(card) {
    var cardEl = el.cardsGrid.querySelector('.card[data-page-id="' + cssEscape(card.pageId) + '"]');
    if (cardEl) {
      var titleEl = cardEl.querySelector('.js-card-title');
      if (titleEl) titleEl.textContent = card.resolvedTitle;
      var imgEl = cardEl.querySelector('.card-thumb');
      if (imgEl) imgEl.setAttribute('alt', card.resolvedTitle);
    }
    // Harmonise aussi le titre affiché si la modale de déblocage de cette
    // même carte est actuellement ouverte.
    if (state.currentUnlockCard && state.currentUnlockCard.pageId === card.pageId && el.unlockModalTitle) {
      el.unlockModalTitle.textContent = card.resolvedTitle;
    }
    if (state.currentUnlockCard === card && el.videoModalTitle && !el.videoModal.classList.contains('hidden')) {
      el.videoModalTitle.textContent = card.resolvedTitle;
    }
  }

  function cssEscape(str) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(str);
    return String(str).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  /* ---------------------------------------------------------------------- */
  /* API YOUTUBE IFRAME — chargement asynchrone                             */
  /* ---------------------------------------------------------------------- */
  window.onYouTubeIframeAPIReady = function () {
    state.ytApiReady = true;
    var queue = state.ytApiReadyQueue;
    state.ytApiReadyQueue = [];
    queue.forEach(function (fn) {
      fn();
    });
  };

  function whenYouTubeApiReady(callback) {
    if (state.ytApiReady && window.YT && window.YT.Player) {
      callback();
    } else {
      state.ytApiReadyQueue.push(callback);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* MODALE VIDÉO LIBRE (depuis les cartes, sans chrono)                    */
  /* ---------------------------------------------------------------------- */
  function openFreeVideoModal(card) {
    if (!card.videoId) {
      showToast('Vidéo indisponible pour ce résumé.', 'error');
      return;
    }
    el.videoModalTitle.textContent = card.resolvedTitle || card.titre;
    openModal(el.videoModal);

    whenYouTubeApiReady(function () {
      // AUTOPLAY : `loadVideoById` démarre déjà la lecture automatiquement
      // (comportement natif de l'API IFrame), donc le player réutilisé
      // relance directement la vidéo sans action supplémentaire de
      // l'utilisateur. Pour un player neuf, `autoplay: 1` dans playerVars
      // + l'appel de sécurité `playVideo()` dans `onReady` garantissent le
      // déclenchement automatique dès que l'iframe est prête.
      if (state.catalogPlayer) {
        state.catalogPlayer.loadVideoById(card.videoId);
      } else {
        state.catalogPlayer = new window.YT.Player('catalog-youtube-player', {
          videoId: card.videoId,
          playerVars: { rel: 0, modestbranding: 1, autoplay: 1, enablejsapi: 1 },
          events: {
            onReady: function (e) {
              try {
                e.target.playVideo();
              } catch (err) {
                /* lecture auto refusée par le navigateur : l'utilisateur clique Play manuellement */
              }
            },
          },
        });
      }
    });
  }

  function closeFreeVideoModal() {
    closeModal(el.videoModal);
    if (state.catalogPlayer && typeof state.catalogPlayer.stopVideo === 'function') {
      try {
        state.catalogPlayer.stopVideo();
      } catch (e) {
        /* player pas encore prêt */
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* PARCOURS DE DÉBLOCAGE : capture email -> modale de téléchargement      */
  /* ---------------------------------------------------------------------- */
  function handleUnlockRequest(card) {
    if (isUserRegistered()) {
      openUnlockModal(card);
    } else {
      state.pendingCard = card;
      openCaptureModal();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* MODALE DE CAPTURE EMAIL (Systeme.io) — SANS AUCUN CONTOURNEMENT        */
  /* ---------------------------------------------------------------------- */
  function openCaptureModal() {
    openModal(el.captureModal);
    watchCaptureFormSubmission();
  }

  function closeCaptureModal() {
    closeModal(el.captureModal);
    disconnectCaptureFormObserver();
  }

  /**
   * Détection de soumission réussie du formulaire Systeme.io, embarqué en
   * iframe cross-origin (impossible de lire son DOM interne pour raisons de
   * sécurité navigateur). Deux heuristiques combinées, sans AUCUN bouton de
   * contournement manuel (exigence absolue du cahier des charges) :
   *   1. postMessage : si le widget Systeme.io émet un message signalant le
   *      succès (mots-clés "success"/"submit"/"thank"), on déclenche
   *      immédiatement le déblocage.
   *   2. Rechargement de l'iframe : la plupart des formulaires Systeme.io
   *      redirigent l'iframe elle-même vers une page de confirmation après
   *      soumission. On ignore le premier évènement "load" (rendu initial du
   *      formulaire) et on considère le second comme une soumission validée.
   */
  function watchCaptureFormSubmission() {
    disconnectCaptureFormObserver();
    state.captureFormLoadCount = 0;

    function bindIframe(iframe) {
      if (!iframe || iframe.__pfBound) return;
      iframe.__pfBound = true;
      iframe.addEventListener('load', function () {
        state.captureFormLoadCount += 1;
        if (state.captureFormLoadCount >= 2) {
          onCaptureFormSuccess();
        }
      });
    }

    // Cas où l'iframe est déjà présente au moment de l'ouverture de la modale.
    var existingIframe = el.modalFormWrapper.querySelector('iframe');
    if (existingIframe) bindIframe(existingIframe);

    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        m.addedNodes &&
          Array.prototype.forEach.call(m.addedNodes, function (node) {
            if (node.tagName === 'IFRAME') {
              bindIframe(node);
            } else if (node.querySelector) {
              var nested = node.querySelector('iframe');
              if (nested) bindIframe(nested);
            }
          });
      });
    });
    observer.observe(el.modalFormWrapper, { childList: true, subtree: true });
    state.captureFormObserver = observer;

    window.addEventListener('message', onWindowMessageForCapture);
  }

  function onWindowMessageForCapture(event) {
    try {
      var raw = event.data;
      var text = typeof raw === 'string' ? raw : JSON.stringify(raw || {});
      var normalized = text.toLowerCase();
      if (
        normalized.indexOf('success') !== -1 ||
        normalized.indexOf('submit') !== -1 ||
        normalized.indexOf('thank') !== -1 ||
        normalized.indexOf('merci') !== -1
      ) {
        onCaptureFormSuccess();
      }
    } catch (e) {
      /* message non exploitable : ignoré */
    }
  }

  function disconnectCaptureFormObserver() {
    if (state.captureFormObserver) {
      state.captureFormObserver.disconnect();
      state.captureFormObserver = null;
    }
    window.removeEventListener('message', onWindowMessageForCapture);
  }

  function onCaptureFormSuccess() {
    disconnectCaptureFormObserver();
    markUserRegistered();
    closeCaptureModal();
    showToast('Inscription réussie ! Votre accès est débloqué.', 'success');

    if (state.pendingCard) {
      var cardToUnlock = state.pendingCard;
      state.pendingCard = null;
      openUnlockModal(cardToUnlock);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* MODALE DE TÉLÉCHARGEMENT — règle des 30 secondes                       */
  /* ---------------------------------------------------------------------- */
  function openUnlockModal(card) {
    state.currentUnlockCard = card;
    resetWatchState();

    el.pdfVolumeBadge.textContent = card.volumeLabel || 'Volume';
    el.unlockModalTitle.textContent = card.resolvedTitle || card.titre;

    // Bouton "Acheter le guide recommandé"
    if (card.guideUrl) {
      el.recommendedGuideBtn.href = card.guideUrl;
      el.recommendedGuideLabel.textContent = card.prixGuideRecommande
        ? 'Acheter le guide recommandé • ' + card.prixGuideRecommande
        : 'Acheter le guide recommandé';
      show(el.recommendedGuideBtn);
    } else {
      hide(el.recommendedGuideBtn);
    }

    // Bouton "Regarder la vidéo sur YouTube"
    el.youtubeCtaBtn.href = card.videoUrl || (card.videoId ? 'https://www.youtube.com/watch?v=' + card.videoId : '#');

    var alreadyUnlocked = state.unlockedPageIds.has(card.pageId);
    setPdfLockedState(!alreadyUnlocked ? true : false);

    openModal(el.unlockModal);

    if (!card.videoId) {
      // Pas de vidéo associée : on ne peut pas exiger 30s de visionnage,
      // on débloque directement pour ne jamais bloquer l'utilisateur.
      setPdfLockedState(false);
      state.unlockedPageIds.add(card.pageId);
      return;
    }

    if (alreadyUnlocked) {
      el.watchProgressFill.style.width = '100%';
      el.watchProgressLabel.textContent = REQUIRED_WATCH_SECONDS + ' / ' + REQUIRED_WATCH_SECONDS + 's regardées';
    }

    whenYouTubeApiReady(function () {
      // AUTOPLAY : même logique que la modale vidéo libre — `autoplay: 1`
      // dans playerVars + `playVideo()` déclenché dans `onReady` pour un
      // player neuf ; `loadVideoById` relance nativement la lecture pour
      // un player déjà instancié (réouverture de la modale).
      if (state.unlockPlayer) {
        state.unlockPlayer.loadVideoById(card.videoId);
      } else {
        state.unlockPlayer = new window.YT.Player('youtube-player', {
          videoId: card.videoId,
          playerVars: { rel: 0, modestbranding: 1, autoplay: 1, enablejsapi: 1 },
          events: {
            onReady: function (e) {
              try {
                e.target.playVideo();
              } catch (err) {
                /* lecture auto refusée par le navigateur : l'utilisateur clique Play manuellement */
              }
            },
            onStateChange: onUnlockPlayerStateChange,
          },
        });
      }
    });
  }

  function resetWatchState() {
    state.watchSeconds = 0;
    if (state.watchIntervalId) {
      clearInterval(state.watchIntervalId);
      state.watchIntervalId = null;
    }
    el.watchProgressFill.style.width = '0%';
    el.watchProgressLabel.textContent = '0 / ' + REQUIRED_WATCH_SECONDS + 's regardées';
  }

  function onUnlockPlayerStateChange(e) {
    var card = state.currentUnlockCard;
    if (!card || state.unlockedPageIds.has(card.pageId)) return;

    if (e.data === window.YT.PlayerState.PLAYING) {
      if (!state.watchIntervalId) {
        state.watchIntervalId = setInterval(function () {
          state.watchSeconds += 1;
          updateWatchProgress();
          if (state.watchSeconds >= REQUIRED_WATCH_SECONDS) {
            clearInterval(state.watchIntervalId);
            state.watchIntervalId = null;
            if (state.currentUnlockCard) state.unlockedPageIds.add(state.currentUnlockCard.pageId);
            setPdfLockedState(false);
          }
        }, 1000);
      }
    } else {
      if (state.watchIntervalId) {
        clearInterval(state.watchIntervalId);
        state.watchIntervalId = null;
      }
    }
  }

  function updateWatchProgress() {
    var pct = Math.min(100, Math.round((state.watchSeconds / REQUIRED_WATCH_SECONDS) * 100));
    el.watchProgressFill.style.width = pct + '%';
    el.watchProgressLabel.textContent =
      Math.min(state.watchSeconds, REQUIRED_WATCH_SECONDS) + ' / ' + REQUIRED_WATCH_SECONDS + 's regardées';
  }

  function setPdfLockedState(locked) {
    el.pdfDirectLink.setAttribute('data-locked', locked ? 'true' : 'false');
    var icon = el.pdfDirectLink.querySelector('i');
    var span = el.pdfDirectLink.querySelector('span');
    if (locked) {
      if (icon) icon.className = 'fa-solid fa-lock';
      if (span) span.textContent = 'Télécharger le résumé PDF gratuit';
    } else {
      if (icon) icon.className = 'fa-solid fa-download';
      if (span) span.textContent = 'Télécharger le résumé PDF gratuit';
    }
  }

  function closeUnlockModal() {
    closeModal(el.unlockModal);
    if (state.unlockPlayer && typeof state.unlockPlayer.stopVideo === 'function') {
      try {
        state.unlockPlayer.stopVideo();
      } catch (e) {
        /* player pas encore prêt */
      }
    }
    if (state.watchIntervalId) {
      clearInterval(state.watchIntervalId);
      state.watchIntervalId = null;
    }
    state.currentUnlockCard = null;
  }

  function handlePdfDownloadClick() {
    var locked = el.pdfDirectLink.getAttribute('data-locked') === 'true';
    if (locked) {
      openModal(el.watchWarningModal);
      return;
    }
    var card = state.currentUnlockCard;
    if (!card) return;

    el.pdfDirectLink.setAttribute('disabled', 'true');
    fetch('/api/pdf/' + encodeURIComponent(card.pageId))
      .then(function (res) {
        if (!res.ok) throw new Error('http_' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.downloadUrl) throw new Error('no_download_url');
        var link = document.createElement('a');
        link.href = data.downloadUrl;
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast('Téléchargement démarré.', 'success');
      })
      .catch(function () {
        showToast('Le téléchargement a échoué. Merci de réessayer.', 'error');
      })
      .finally(function () {
        el.pdfDirectLink.removeAttribute('disabled');
      });
  }

  /* ---------------------------------------------------------------------- */
  /* GESTION GÉNÉRIQUE DES MODALES (overlay + card + focus + Escape)        */
  /* ---------------------------------------------------------------------- */
  var openModalsStack = [];

  function openModal(modalEl) {
    modalEl.classList.remove('hidden');
    requestAnimationFrame(function () {
      modalEl.classList.add('is-visible');
    });
    document.body.style.overflow = 'hidden';
    if (openModalsStack.indexOf(modalEl) === -1) openModalsStack.push(modalEl);
  }

  function closeModal(modalEl) {
    modalEl.classList.remove('is-visible');
    setTimeout(function () {
      modalEl.classList.add('hidden');
    }, 260);
    openModalsStack = openModalsStack.filter(function (m) {
      return m !== modalEl;
    });
    if (openModalsStack.length === 0) {
      document.body.style.overflow = '';
    }
  }

  function closeTopModal() {
    if (openModalsStack.length === 0) return;
    var top = openModalsStack[openModalsStack.length - 1];
    dispatchModalClose(top);
  }

  function dispatchModalClose(modalEl) {
    if (modalEl === el.captureModal) closeCaptureModal();
    else if (modalEl === el.videoModal) closeFreeVideoModal();
    else if (modalEl === el.unlockModal) closeUnlockModal();
    else if (modalEl === el.watchWarningModal) closeModal(el.watchWarningModal);
    else closeModal(modalEl);
  }

  function initModalsGenericBehavior() {
    [el.captureModal, el.videoModal, el.unlockModal, el.watchWarningModal].forEach(function (modalEl) {
      if (!modalEl) return;
      modalEl.addEventListener('click', function (e) {
        if (e.target === modalEl) dispatchModalClose(modalEl);
      });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeTopModal();
    });

    if (el.modalCloseBtn) el.modalCloseBtn.addEventListener('click', function () { closeCaptureModal(); });
    if (el.videoModalCloseBtn) el.videoModalCloseBtn.addEventListener('click', closeFreeVideoModal);
    if (el.unlockModalCloseBtn) el.unlockModalCloseBtn.addEventListener('click', closeUnlockModal);
    if (el.watchWarningCloseBtn)
      el.watchWarningCloseBtn.addEventListener('click', function () {
        closeModal(el.watchWarningModal);
      });
    if (el.watchWarningOkBtn)
      el.watchWarningOkBtn.addEventListener('click', function () {
        closeModal(el.watchWarningModal);
      });
  }

  /* ---------------------------------------------------------------------- */
  /* BOUTONS D'ACTION SUPPLÉMENTAIRES                                       */
  /* ---------------------------------------------------------------------- */
  function initActionButtons() {
    if (el.pdfDirectLink) el.pdfDirectLink.addEventListener('click', handlePdfDownloadClick);

    if (el.unlockCoachingBtn) {
      el.unlockCoachingBtn.addEventListener('click', function () {
        closeUnlockModal();
        smoothScrollToId('formules');
      });
    }

    if (el.retryBtn) {
      el.retryBtn.addEventListener('click', loadCatalog);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* INITIALISATION GÉNÉRALE                                                */
  /* ---------------------------------------------------------------------- */
  function init() {
    cacheDom();
    initThemeSwitcher();
    initHeaderMenu();
    initSearch();
    initModalsGenericBehavior();
    initActionButtons();
    loadSocialProofStats();
    loadCatalog();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
