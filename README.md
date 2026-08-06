# PsychoFéminine — Catalogue interactif de résumés PDF & guides vidéo

## Aperçu du projet
- **Nom** : PsychoFéminine
- **Objectif** : Offrir un catalogue interactif de résumés PDF gratuits liés à des vidéos YouTube, avec déblocage conditionné à une inscription e-mail (Systeme.io) et à 30 secondes de visionnage effectif, puis proposer des guides recommandés et du coaching privé.
- **Stack** : Hono (TypeScript) + Cloudflare Pages/Workers, JS vanilla ES6+ côté client, CSS custom (design system à 3 thèmes).

## Fonctionnalités actuellement complétées
- **Catalogue Notion en temps réel** via `GET /api/notion` (Worker Hono, le `NOTION_TOKEN` ne quitte jamais le serveur). Filtrage strict `Statut === "Publié"`.
- **Mapping Notion strict** : `TITRE`, `Liens Vidéos YouTube`, `Fichier PDF`, `Lien du Guide Recommandé` (+ variantes), `Prix Guide Recommandé`, `Thématique`, `Statut` (gère `select` ET `status`).
- **Miniature + titre YouTube dynamiques** : extraction de l'ID vidéo, `maxresdefault.jpg` avec repli auto vers `hqdefault.jpg`, titre exact via oEmbed (`/api/youtube-meta/:videoId`), avec repli sur `TITRE` Notion.
- **Hero + preuve sociale dynamique** : titre **"Résumés & Guides PDF Gratuits de nos Vidéos"**, avatars superposés + compteur d'inscrits (`/api/stats` externe, fallback 1200).
- **Recherche & filtres par thématique** en temps réel, **skeleton loading**, **toasts**, **empty/error states**.
- **Accès strict Systeme.io** : aucun bypass. Le formulaire s'ouvre tant que `user_email` n'existe pas en `localStorage` ; succès détecté (postMessage / rechargement iframe) → `localStorage.user_email` + toast + ouverture de la modale de déblocage.
- **Règle des 30 secondes de visionnage** : lecteur `YT.Player` (API IFrame), barre de progression dynamique, bouton PDF verrouillé/déverrouillé automatiquement.
- **4 boutons de la modale de déblocage** : Télécharger le PDF (proxy `/api/download/:pageId`, forcé en pièce jointe), Acheter le guide recommandé (prix Notion), Regarder sur YouTube (rouge officiel), Réserver un Coaching Privé (scroll `#formules`).
- **Header** : logo, switcher de thème (Sombre `#0A192F` / Clair / Intermédiaire, persistant via `localStorage.theme`), menu burger (Coaching Privé → scroll `#formules` ; Formations → `https://psychofeminine.mychariow.shop` ; Se connecter → capture e-mail ou toast si déjà connecté).
- **Correctif anti-clignotement** : le menu burger et le switcher de thème utilisent désormais exclusivement la classe `.is-open` pilotée en CSS (`opacity`/`pointer-events`), avec `e.stopPropagation()` sur les boutons et sur les dropdowns eux-mêmes — plus aucune race condition entre `setTimeout`/`requestAnimationFrame` et le listener global de fermeture.
- **Autoplay vidéo** : `autoplay=1&enablejsapi=1` + `player.playVideo()` déclenché dans `onReady`, pour la modale de lecture libre et pour la modale de déblocage (règle des 30s).
- **Section Coaching Privé (`#formules`)** conservée à l'identique (Séance découverte / Coaching complet / Accompagnement VIP).

## Entrées fonctionnelles (endpoints)
| Méthode | Route | Description |
|---|---|---|
| GET | `/` | Page d'accueil (SSR Hono JSX) |
| GET | `/api/notion` | Catalogue brut Notion, filtré `Statut === "Publié"` — `{ results: [...] }` |
| GET | `/api/volumes` | Catalogue normalisé côté serveur (compat interne) |
| GET | `/api/pdf/:pageId` | Métadonnées + URL de téléchargement du PDF d'une fiche publiée |
| GET | `/api/download/:pageId` | Téléchargement forcé du PDF (`Content-Disposition: attachment`) |
| GET | `/api/youtube-meta/:videoId` | Titre exact YouTube via oEmbed (proxy + cache 6h) |

## Non encore implémenté / pistes d'amélioration
- Espace Membre dédié (au-delà du simple flag `user_email` en `localStorage`).
- Statistiques d'usage internes (vues, téléchargements) — actuellement seul le compteur externe `/api/stats` est utilisé pour la preuve sociale.
- Détection de soumission Systeme.io 100% fiable indépendante du comportement de l'iframe (actuellement : heuristique postMessage + double `load` de l'iframe).

## Modèle de données & stockage
- **Source de vérité** : base Notion (`database_id = 7a233b9f9f8e44b9a0805ef492276ac9`), interrogée exclusivement côté Worker (`src/notion.ts`).
- **Aucune base Cloudflare (D1/KV/R2)** n'est utilisée pour l'instant : tout est recalculé à la demande depuis Notion, avec cache HTTP léger sur l'endpoint oEmbed.
- **Session utilisateur** : `localStorage.user_email` (déblocage), `localStorage.theme` (thème préféré).

## Guide utilisateur
1. Parcourir le catalogue, filtrer par thématique ou rechercher un mot-clé.
2. Cliquer sur une carte pour regarder la vidéo (lecture libre) ou sur "Débloquer le résumé PDF".
3. Si première visite : renseigner son e-mail dans le formulaire Systeme.io (obligatoire, aucun contournement).
4. Regarder au moins 30 secondes de la vidéo dans la modale de déblocage pour activer le téléchargement du PDF.
5. Accéder en un clic au guide recommandé, à la vidéo YouTube ou à une réservation de coaching privé.

## Déploiement
- **Plateforme** : Cloudflare Pages (Hono + Workers)
- **Secret requis** : `NOTION_TOKEN` (jamais commité — `.dev.vars` en local, secret Cloudflare en production)
- **Variable** : `NOTION_DATABASE_ID = 7a233b9f9f8e44b9a0805ef492276ac9`
- **Statut** : ✅ Actif en développement (sandbox) — déploiement production à confirmer avec l'utilisateur (Cloudflare BYOK ou hébergement Genspark)
- **Dernière mise à jour** : 2026-08-06
