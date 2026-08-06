import { Hono } from 'hono'
import { renderer } from './renderer'
import { fetchPublishedVolumes, fetchPageWithPdfUrl, fetchNotionRawPublished } from './notion'

type Bindings = {
  NOTION_TOKEN: string
  NOTION_DATABASE_ID: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use(renderer)

// ---------------------------------------------------------------------------
// API : GET /api/notion — proxy sécurisé du catalogue Notion, format natif
// { results: [...] } avec item.properties['TITRE'], ['Liens Vidéos YouTube'],
// ['Fichier PDF'], ['Lien du Guide Recommandé'], ['Prix Guide Recommandé'],
// ['Thématique'], ['Statut']. Le NOTION_TOKEN ne quitte jamais ce Worker.
// Seules les fiches Statut === "Publié" sont renvoyées (défense en
// profondeur : le Front-End refiltre aussi de son côté).
// ---------------------------------------------------------------------------
app.get('/api/notion', async (c) => {
  const { NOTION_TOKEN, NOTION_DATABASE_ID } = c.env
  if (!NOTION_TOKEN || !NOTION_DATABASE_ID) {
    return c.json({ error: 'Configuration Notion manquante côté serveur.' }, 500)
  }
  try {
    const results = await fetchNotionRawPublished(NOTION_DATABASE_ID, NOTION_TOKEN)
    return c.json({ results })
  } catch (err) {
    console.error(err)
    return c.json({ error: 'Impossible de charger le catalogue depuis Notion.' }, 502)
  }
})

// ---------------------------------------------------------------------------
// API : liste des volumes publiés depuis Notion (triés par ordre décroissant)
// Conservée pour compatibilité interne (mapping déjà normalisé côté serveur).
// ---------------------------------------------------------------------------
app.get('/api/volumes', async (c) => {
  const { NOTION_TOKEN, NOTION_DATABASE_ID } = c.env
  if (!NOTION_TOKEN || !NOTION_DATABASE_ID) {
    return c.json({ error: 'Configuration Notion manquante côté serveur.' }, 500)
  }
  try {
    const volumes = await fetchPublishedVolumes(NOTION_DATABASE_ID, NOTION_TOKEN)
    return c.json({ volumes })
  } catch (err) {
    console.error(err)
    return c.json({ error: 'Impossible de charger le catalogue depuis Notion.' }, 502)
  }
})

// ---------------------------------------------------------------------------
// API : URL du PDF pour un volume donné (déverrouillé après capture email)
// Le lien Notion S3 est signé et temporaire -> on ne l'expose qu'à la demande,
// jamais dans la liste globale.
// ---------------------------------------------------------------------------
app.get('/api/pdf/:pageId', async (c) => {
  const { NOTION_TOKEN, NOTION_DATABASE_ID } = c.env
  const pageId = c.req.param('pageId')
  if (!NOTION_TOKEN || !NOTION_DATABASE_ID) {
    return c.json({ error: 'Configuration Notion manquante côté serveur.' }, 500)
  }
  try {
    const result = await fetchPageWithPdfUrl(pageId, NOTION_DATABASE_ID, NOTION_TOKEN)
    if (!result || !result.pdfUrl) {
      return c.json({ error: 'PDF introuvable ou non publié.' }, 404)
    }
    return c.json({
      titre: result.card.titre,
      volumeLabel: result.card.volumeLabel,
      thematique: result.card.thematique,
      videoUrl: result.card.videoUrl,
      videoId: result.card.videoId,
      guideUrl: result.card.guideUrl,
      prixGuideRecommande: result.card.prixGuideRecommande,
      // On ne renvoie jamais le lien S3 signé brut au navigateur : le
      // téléchargement se fait exclusivement via /api/download/:pageId
      // (forçage attachment).
      downloadUrl: `/api/download/${encodeURIComponent(pageId)}`,
    })
  } catch (err) {
    console.error(err)
    return c.json({ error: 'Erreur lors de la récupération du PDF.' }, 502)
  }
})

// ---------------------------------------------------------------------------
// API : téléchargement direct forcé du PDF (Content-Disposition: attachment)
// Le Worker joue le rôle de proxy : il récupère le fichier depuis Notion/S3 et
// le ré-émet avec les en-têtes qui déclenchent le téléchargement automatique
// sur l'appareil, plutôt que de laisser le navigateur ouvrir/afficher le PDF.
// ---------------------------------------------------------------------------
app.get('/api/download/:pageId', async (c) => {
  const { NOTION_TOKEN, NOTION_DATABASE_ID } = c.env
  const pageId = c.req.param('pageId')
  if (!NOTION_TOKEN || !NOTION_DATABASE_ID) {
    return c.json({ error: 'Configuration Notion manquante côté serveur.' }, 500)
  }
  try {
    const result = await fetchPageWithPdfUrl(pageId, NOTION_DATABASE_ID, NOTION_TOKEN)
    if (!result || !result.pdfUrl) {
      return c.json({ error: 'PDF introuvable ou non publié.' }, 404)
    }

    const fileRes = await fetch(result.pdfUrl)
    if (!fileRes.ok || !fileRes.body) {
      return c.json({ error: 'Impossible de récupérer le fichier PDF.' }, 502)
    }

    const safeTitre =
      (result.card.titre || 'resume')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9\-_\s]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .toLowerCase() || 'resume'
    const filename = `${safeTitre}.pdf`

    return new Response(fileRes.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error(err)
    return c.json({ error: 'Erreur lors du téléchargement du PDF.' }, 502)
  }
})

// ---------------------------------------------------------------------------
// API : métadonnées YouTube (titre exact & à jour) via oEmbed — proxy serveur
// pour éviter d'exposer des appels tiers directement depuis le navigateur et
// pour bénéficier d'un cache HTTP léger côté edge.
// ---------------------------------------------------------------------------
app.get('/api/youtube-meta/:videoId', async (c) => {
  const videoId = c.req.param('videoId')
  if (!videoId || !/^[\w-]{6,15}$/.test(videoId)) {
    return c.json({ title: null }, 200)
  }
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`
    )}&format=json`
    const res = await fetch(oembedUrl)
    if (!res.ok) return c.json({ title: null }, 200)
    const data = (await res.json()) as { title?: string }
    return c.json(
      { title: data.title || null },
      200,
      { 'Cache-Control': 'public, max-age=21600' } // 6h
    )
  } catch (err) {
    return c.json({ title: null }, 200)
  }
})

// ---------------------------------------------------------------------------
// Page d'accueil
// ---------------------------------------------------------------------------
app.get('/', (c) => {
  return c.render(
    <div id="app-root">
      {/* ---------- HEADER ---------- */}
      <header id="site-header" class="site-header">
        <div class="header-inner">
          <a href="/" class="brand">
            <img
              src="https://i.postimg.cc/tJPrM4HY/file-1784894285304.jpg"
              alt="PsychoFéminine"
              class="w-10 h-10 rounded-full object-cover brand-logo"
            />
            <span class="brand-text">Psycho<span class="brand-accent">Féminine</span></span>
          </a>

          <div class="header-actions">
            {/* Switcher de thème : Sombre / Clair / Intermédiaire (grisé) */}
            <div class="theme-switcher" id="theme-switcher">
              <button
                type="button"
                class="theme-switcher-btn"
                id="theme-switcher-btn"
                aria-haspopup="true"
                aria-expanded="false"
                aria-label="Changer de thème"
                title="Changer de thème"
              >
                <i class="fa-solid fa-circle-half-stroke" id="theme-switcher-icon"></i>
              </button>
              <div id="theme-switcher-dropdown" class="theme-switcher-dropdown hidden" role="menu">
                <button type="button" class="theme-option" data-theme-value="dark" role="menuitem">
                  <i class="fa-solid fa-moon"></i> Sombre
                </button>
                <button type="button" class="theme-option" data-theme-value="light" role="menuitem">
                  <i class="fa-solid fa-sun"></i> Clair
                </button>
                <button type="button" class="theme-option" data-theme-value="dim" role="menuitem">
                  <i class="fa-solid fa-circle-half-stroke"></i> Intermédiaire
                </button>
              </div>
            </div>

            {/* Menu déroulant (icône menu à droite) : Coaching Privé / Formations / Se connecter */}
            <div class="header-menu" id="header-menu">
              <button id="header-menu-btn" class="header-menu-btn" aria-haspopup="true" aria-expanded="false" aria-label="Menu">
                <i class="fa-solid fa-bars"></i>
              </button>
              <div id="header-menu-dropdown" class="header-menu-dropdown hidden" role="menu">
                {/* 1. Coaching Privé : reste sur la même interface, scroll fluide vers #formules */}
                <a href="#formules" class="header-menu-item" id="header-menu-coaching" role="menuitem">
                  <i class="fa-solid fa-handshake"></i> Coaching Privé
                </a>
                {/* 2. Formations : redirection externe directe vers la boutique Chariow */}
                <a
                  href="https://psychofeminine.mychariow.shop"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="header-menu-item"
                  id="header-menu-formations"
                  role="menuitem"
                >
                  <i class="fa-solid fa-graduation-cap"></i> Formations
                </a>
                {/* 3. Se connecter : vérifie user_email en localStorage (JS) */}
                <button type="button" class="header-menu-item" id="header-menu-login" role="menuitem">
                  <i class="fa-solid fa-user"></i> Se connecter
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Bannière compteur dynamique — le chiffre est injecté en JS depuis
            items.length, aucune valeur n'est écrite en dur ici. */}
        <div class="header-counter-banner" id="header-counter-banner">
          <i class="fa-solid fa-layer-group"></i>
          <span id="header-counter-text">Chargement du catalogue…</span>
        </div>
      </header>

      {/* ---------- HERO ---------- */}
      <section class="hero" id="hero-section">
        <div class="hero-glow" aria-hidden="true"></div>
        <div class="hero-inner">
          <h1 class="hero-title">
            Résumés &amp; Guides PDF <span class="hero-title-accent">Gratuits de nos Vidéos</span>
          </h1>

          {/* ---- PREUVE SOCIALE DYNAMIQUE : avatars superposés + compteur d'inscrits ---- */}
          <div class="hero-social-proof" id="hero-social-proof">
            <div class="social-proof-avatars" aria-hidden="true">
              <img src="https://i.postimg.cc/j5W3TFXp/IMG-20260428-WA0009.jpg" alt="" class="social-proof-avatar" loading="lazy" />
              <img src="https://i.postimg.cc/8ztZ6Sns/IMG-20260724-WA0016.jpg" alt="" class="social-proof-avatar" loading="lazy" />
              <img src="https://i.postimg.cc/J7NcX8s1/file-1785143982032.jpg" alt="" class="social-proof-avatar" loading="lazy" />
            </div>
            <span class="social-proof-text" id="social-proof-text">
              <i class="fa-solid fa-users"></i> +1 200 hommes et femmes déjà inscrits
            </span>
          </div>

          <p class="hero-subtitle">
            Téléchargez gratuitement le résumé PDF de nos vidéos et accédez au guide recommandé pour aller plus loin.
          </p>
          <div class="hero-stats" id="hero-stats">
            <div class="hero-stat">
              <span class="hero-stat-value" id="stat-count">—</span>
              <span class="hero-stat-label">Résumés disponibles</span>
            </div>
            <div class="hero-stat">
              <span class="hero-stat-value"><i class="fa-solid fa-infinity"></i></span>
              <span class="hero-stat-label">Accès gratuit &amp; illimité</span>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- GRID SECTION ---------- */}
      <main class="catalog-section" id="catalog-section">
        <div class="catalog-inner">
          {/* Barre de recherche en temps réel */}
          <div class="search-bar-wrapper">
            <div class="search-bar" id="search-bar">
              <i class="fa-solid fa-magnifying-glass search-bar-icon"></i>
              <input
                type="text"
                id="search-input"
                class="search-input"
                placeholder="Rechercher un résumé, une thématique…"
                autocomplete="off"
                aria-label="Rechercher un résumé"
              />
              <button type="button" id="search-clear-btn" class="search-clear-btn hidden" aria-label="Effacer la recherche">
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
          </div>
          <div id="filters-bar" class="filters-bar"></div>
          <div id="cards-grid" class="cards-grid" aria-live="polite">
            {/* Squelettes de chargement (bannière + titre + avis + 2 boutons côte à côte) */}
            {Array.from({ length: 8 }).map((_, i) => (
              <div class="card card-skeleton" key={i}>
                <div class="skeleton-thumb"></div>
                <div class="card-body">
                  <div class="skeleton-line skeleton-line-title"></div>
                  <div class="skeleton-line skeleton-line-tag"></div>
                  <div class="skeleton-actions-row">
                    <div class="skeleton-btn"></div>
                    <div class="skeleton-btn"></div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div id="empty-state" class="empty-state hidden">
            <i class="fa-regular fa-folder-open"></i>
            <p>Aucun résumé publié pour le moment. Revenez bientôt !</p>
          </div>
          <div id="error-state" class="error-state hidden">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <p id="error-message">Une erreur est survenue lors du chargement du catalogue.</p>
            <button id="retry-btn" class="btn btn-secondary">Réessayer</button>
          </div>
        </div>
      </main>

      {/* ---------- SECTION COACHING PRIVÉ / FORMULES ----------
          Cible du menu "Coaching Privé" (scroll interne fluide, aucune
          redirection externe, aucun rechargement de page). */}
      <section class="formules-section" id="formules">
        <div class="formules-inner">
          <span class="formules-badge">
            <i class="fa-solid fa-handshake"></i> Coaching Privé
          </span>
          <h2 class="formules-title">Envie d'aller plus loin&nbsp;? Réservez votre coaching privé</h2>
          <p class="formules-subtitle">
            Un accompagnement personnalisé pour transformer durablement votre vie amoureuse et émotionnelle.
          </p>
          <div class="formules-grid">
            <div class="formule-card">
              <div class="formule-icon"><i class="fa-solid fa-comments"></i></div>
              <h3 class="formule-name">Séance découverte</h3>
              <p class="formule-desc">Un premier échange pour identifier vos blocages et poser les bases de votre accompagnement.</p>
            </div>
            <div class="formule-card formule-card-highlight">
              <div class="formule-icon"><i class="fa-solid fa-heart-circle-check"></i></div>
              <h3 class="formule-name">Coaching complet</h3>
              <p class="formule-desc">Un suivi personnalisé sur plusieurs semaines pour un accompagnement en profondeur.</p>
            </div>
            <div class="formule-card">
              <div class="formule-icon"><i class="fa-solid fa-crown"></i></div>
              <h3 class="formule-name">Accompagnement VIP</h3>
              <p class="formule-desc">Un accès prioritaire et illimité à mon expertise pour une transformation express.</p>
            </div>
          </div>
          <a
            href="https://coachingprive-psychofeminine.netlify.app/"
            target="_blank"
            rel="noopener noreferrer"
            class="btn btn-primary formules-cta"
          >
            <i class="fa-solid fa-calendar-check"></i> Réserver mon Coaching Privé
          </a>
        </div>
      </section>

      {/* ---------- FOOTER ---------- */}
      <footer class="site-footer">
        <p>© {new Date().getFullYear()} PsychoFéminine — Tous droits réservés.</p>
      </footer>

      {/* ---------- MODALE CAPTURE EMAIL (obligatoire, aucun bypass) ---------- */}
      <div id="capture-modal" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-card" id="modal-card">
          <button id="modal-close-btn" class="modal-close-btn" aria-label="Fermer">
            <i class="fa-solid fa-xmark"></i>
          </button>

          <div class="modal-head">
            <span class="modal-icon"><i class="fa-solid fa-lock-open"></i></span>
            <h3 id="modal-title" class="modal-title">Débloquez ce résumé gratuitement</h3>
            <p class="modal-subtitle" id="modal-subtitle">
              Entrez votre e-mail pour accéder instantanément au PDF.
            </p>
          </div>

          <div class="modal-form-wrapper" id="modal-form-wrapper">
            {/* Formulaire Systeme.io — capture e-mail obligatoire.
                Le script injecte lui-même son iframe dans ce conteneur. */}
            <script
              id="form-script-tag-24979626"
              src="https://www.studiovision-ia.site/public/remote/page/43326150de8c940a29ab1a2266f0da19013700b7.js"
            ></script>
          </div>

          {/* SÉCURITÉ ABSOLUE : aucun bouton de contournement du formulaire.
              L'accès au résumé est strictement conditionné à la soumission
              réelle et validée du formulaire Systeme.io ci-dessus. */}

          <p class="modal-privacy">
            <i class="fa-solid fa-shield-halved"></i> Vos données restent confidentielles. Désinscription possible à tout moment.
          </p>
        </div>
      </div>

      {/* ---------- MODALE LECTEUR VIDÉO LIBRE (depuis les cartes du catalogue) ----------
          Lecture libre, SANS chrono ni déblocage : permet de regarder la vidéo YouTube
          directement sur la page, dans une fenêtre modale, sans quitter le site. */}
      <div id="video-modal" class="modal-overlay video-modal-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="video-modal-title">
        <div class="modal-card video-modal-card" id="video-modal-card">
          <button id="video-modal-close-btn" class="modal-close-btn" aria-label="Fermer la vidéo">
            <i class="fa-solid fa-xmark"></i>
          </button>
          <h3 id="video-modal-title" class="modal-title video-modal-title">Vidéo</h3>
          <div class="video-frame" id="catalog-video-frame">
            <div id="catalog-youtube-player"></div>
          </div>
        </div>
      </div>

      {/* ---------- MODALE DE TÉLÉCHARGEMENT (post-déblocage e-mail) ----------
          C'est ICI, et EXCLUSIVEMENT ici, que s'applique la règle des 30 secondes
          de visionnage avant de pouvoir télécharger le PDF. Ordre des boutons :
          1. Télécharger le résumé PDF gratuit
          2. Acheter le guide recommandé • [Prix]
          3. Regarder la vidéo sur YouTube
          4. Réserver un Coaching Privé */}
      <div id="unlock-modal" class="modal-overlay unlock-modal-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="unlock-modal-title">
        <div class="modal-card unlock-modal-card" id="unlock-modal-card">
          <button id="unlock-modal-close-btn" class="modal-close-btn" aria-label="Fermer">
            <i class="fa-solid fa-xmark"></i>
          </button>

          {/* Titre du résumé / de la vidéo (titre dynamique YouTube — même
              source que la carte du catalogue) */}
          <div class="pdf-header">
            <span class="pdf-volume-badge" id="pdf-volume-badge">Volume</span>
            <h2 class="pdf-title" id="unlock-modal-title">Titre du résumé</h2>
          </div>

          {/* Lecteur de la Vidéo YouTube (avec suivi des 30 secondes via IFrame API) */}
          <div class="video-frame" id="video-frame">
            <div id="youtube-player"></div>
          </div>

          {/* Barre de progression du visionnage (30s requises) */}
          <div class="watch-progress" id="watch-progress">
            <div class="watch-progress-bar">
              <div class="watch-progress-fill" id="watch-progress-fill"></div>
            </div>
            <span class="watch-progress-label" id="watch-progress-label">0 / 30s regardées</span>
          </div>

          {/* 1. Télécharger le résumé PDF gratuit (verrouillé tant que 30s non atteintes) */}
          <button id="pdf-direct-link" class="btn btn-pdf-main btn-cta-full" data-locked="true">
            <i class="fa-solid fa-lock"></i>
            <span>Télécharger le résumé PDF gratuit</span>
          </button>

          {/* 2. Acheter le guide recommandé (bleu, sans étoile, prix Notion) */}
          <a
            id="recommended-guide-btn"
            class="btn btn-recommended btn-cta-full hidden"
            href="#"
            target="_blank"
            rel="noopener noreferrer"
          >
            <i class="fa-solid fa-cart-shopping"></i>
            <span id="recommended-guide-label">Acheter le guide recommandé</span>
          </a>

          {/* 3. Regarder la vidéo sur YouTube (rouge officiel) */}
          <a
            id="youtube-cta-btn"
            class="btn btn-youtube btn-cta-full"
            href="#"
            target="_blank"
            rel="noopener noreferrer"
          >
            <i class="fa-brands fa-youtube"></i> Regarder la vidéo sur YouTube
          </a>

          {/* 4. Réserver un Coaching Privé — ferme la modale puis scroll fluide
              vers la section #formules (reste sur la même interface, aucune
              redirection externe depuis ce bouton). */}
          <div class="pdf-cta-row">
            <button type="button" id="unlock-coaching-btn" class="btn btn-outline btn-cta">
              <i class="fa-solid fa-handshake"></i> Réserver un Coaching Privé
            </button>
          </div>
        </div>
      </div>

      {/* ---------- MODALE D'AVERTISSEMENT (30 secondes de visionnage requises) ---------- */}
      <div id="watch-warning-modal" class="modal-overlay hidden" role="alertdialog" aria-modal="true" aria-labelledby="watch-warning-title">
        <div class="modal-card modal-card-small" id="watch-warning-card">
          <button id="watch-warning-close-btn" class="modal-close-btn" aria-label="Fermer">
            <i class="fa-solid fa-xmark"></i>
          </button>
          <div class="modal-head">
            <span class="modal-icon modal-icon-warning"><i class="fa-solid fa-circle-play"></i></span>
            <h3 id="watch-warning-title" class="modal-title">Visionnage requis</h3>
            <p class="modal-subtitle">
              Veuillez regarder au moins 30 secondes de la vidéo pour débloquer votre résumé gratuit.
            </p>
          </div>
          <button id="watch-warning-ok-btn" class="btn btn-primary btn-cta-full">
            J'ai compris
          </button>
        </div>
      </div>

      {/* ---------- TOAST NOTIFICATIONS (feedback visuel éphémère, bas-droite) ---------- */}
      <div id="toast-container" class="toast-container" aria-live="polite" aria-atomic="true"></div>

      <script async src="https://www.youtube.com/iframe_api"></script>
      <script src="/static/app.js"></script>
    </div>
  )
})

export default app
