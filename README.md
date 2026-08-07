# PsychoFéminine

## Aperçu du projet
- **Nom** : PsychoFéminine — plateforme de résumés PDF & vidéos guides.
- **Objectif** : Offrir gratuitement des résumés PDF de vidéos YouTube, avec capture e-mail (Systeme.io), règle de visionnage de 30s avant déblocage, et mise en avant du Coaching Privé.
- **Fonctionnalités** :
  - Catalogue dynamique alimenté par Notion (sécurisé, aucun token exposé côté client).
  - Récupération dynamique des titres/miniatures YouTube via oEmbed.
  - Aucune déduplication des `guideUrl` entre les fiches.
  - Header/menu : Coaching Privé (scroll interne vers `#formules`), Formations (lien externe), Se connecter (vérification `localStorage`).
  - Section Coaching Privé (`#formules`) avec 3 formules fixes.
  - Règle de visionnage 30 secondes avec barre de progression avant déverrouillage du PDF.
  - Lecture automatique (autoplay) de la vidéo YouTube au clic sur "Regarder la vidéo".
  - Badge héro (au-dessus du H1) supprimé.

## URLs
- **Production (déploiement GitHub-lié Cloudflare Pages)** : https://psychofeminine.pages.dev
- **GitHub** : https://github.com/motivvation96-gif/Psychofeminine (branche `main`)
- **API Notion (proxy sécurisé)** : `/api/notion`, `/api/volumes`, `/api/pdf/:pageId`, `/api/download/:pageId`, `/api/youtube-meta/:videoId`
- **Formations (lien externe)** : https://psychofeminine-boutique.netlify.app/
- **Coaching Privé (lien externe, CTA)** : https://coachingprive-psychofeminine.netlify.app/

## Architecture des données
- **Modèles de données** : Fiches Notion (Titre, Liens Vidéos YouTube, Fichier PDF, Lien du Guide Recommandé, Prix Guide Recommandé, Thématique, Statut).
- **Services de stockage** : Notion API (base de données) — accès exclusivement côté serveur (Cloudflare Worker).
- **Flux de données** : Le Worker Hono interroge l'API Notion, normalise les propriétés (variantes de noms de colonnes), et expose un catalogue filtré (`Statut === "Publié"`) au frontend via des routes `/api/*`. Le token Notion (`NOTION_TOKEN`) ne quitte jamais le Worker.

## Guide utilisateur
1. Parcourez le catalogue de résumés sur la page d'accueil.
2. Cliquez sur une fiche pour capturer votre e-mail (formulaire Systeme.io obligatoire).
3. Regardez au moins 30 secondes de la vidéo YouTube (lecture automatique) pour débloquer le téléchargement du PDF.
4. Téléchargez le résumé PDF gratuit, achetez le guide recommandé, ou réservez un Coaching Privé via la section `#formules`.

## Déploiement
- **Plateforme** : Cloudflare Pages — **déploiement GitHub-lié** (Workers for Platforms / Pages Git integration), utilisant le dépôt `motivvation96-gif/Psychofeminine` (branche `main`).
- **Compte Cloudflare** : compte de l'utilisateur (BYOK — Bring Your Own Key / API Token).
- **Configuration de build Cloudflare Pages** :
  - Build command : `npm run build`
  - Build output directory : `dist`
  - Root directory : `/` (racine du repo)
- **Variables/secrets d'environnement (Production & Preview)** :
  - `NOTION_DATABASE_ID` (plain text) : `7a233b9f9f8e44b9a0805ef492276ac9`
  - `NOTION_TOKEN` (secret) : configuré directement sur le projet Cloudflare Pages (jamais commité, jamais exposé côté client).
- **Statut** : ✅ Actif — dernier déploiement réussi automatiquement depuis le commit `56747b1` (branche `main`).
- **Stack technique** : Hono + TypeScript + Vite (`@hono/vite-build/cloudflare-pages`) + TailwindCSS (CDN) + FontAwesome (CDN).
- **Dernière mise à jour** : 2026-08-07 — Lien "Formations" mis à jour vers `https://psychofeminine-boutique.netlify.app/` ; migration du déploiement Cloudflare Pages vers l'intégration GitHub (auto-déploiement à chaque push sur `main`).

### Note technique — build Cloudflare Pages
Ce projet est un Worker Hono construit avec Vite (`vite build` génère `dist/_worker.js` + assets statiques). Un build output directory à la racine (`/`) avec commande de build vide **ne fonctionnerait pas** pour cette stack : rien d'exécutable n'existe à la racine sans l'étape `npm run build`. La configuration correcte et validée en production est :
- Build command : `npm run build`
- Build output directory : `dist`

Cette configuration a été appliquée sur le projet Cloudflare Pages `psychofeminine` lors de la liaison au dépôt GitHub, et le déploiement automatique a réussi (build + deploy stages en statut `success`).
