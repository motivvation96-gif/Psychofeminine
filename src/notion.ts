// =============================================================================
// src/notion.ts — Couche d'accès à l'API Notion (source de vérité du catalogue)
//
// SÉCURITÉ : ce module ne doit JAMAIS être importé côté client. Il vit
// exclusivement dans le Worker Cloudflare (Hono) et manipule le NOTION_TOKEN
// qui n'est jamais transmis au navigateur.
//
// ROBUSTESSE DE MAPPING : la base Notion réelle contient des noms de colonnes
// avec parfois un espace parasite en fin de libellé (ex. "Liens Vidéos
// YouTube " avec un espace final) ou des variantes dupliquées ("Lien Guide
// Recommandé" vs "Lien du Guide Recommandé"). On résout donc chaque propriété
// via une normalisation (trim + lowercase) et une liste de candidats classés
// par priorité : le premier candidat non-vide gagne.
// =============================================================================

const NOTION_API_BASE = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------
export interface NotionCard {
  id: string
  titre: string
  statut: string | null
  thematique: string | null
  volumeLabel: string | null
  volumeNumber: number | null
  videoUrl: string | null
  videoId: string | null
  guideUrl: string | null
  prixGuideRecommande: string | null
  hasPdf: boolean
  isNew: boolean
}

export interface NotionCardWithPdf {
  card: NotionCard
  pdfUrl: string | null
}

// -----------------------------------------------------------------------------
// Utilitaires de résolution de propriétés (résistant aux variantes de noms)
// -----------------------------------------------------------------------------
function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Retourne la clé RÉELLE de `properties` correspondant au premier candidat
 * (dans l'ordre de priorité) qui existe, après normalisation (trim +
 * lowercase + espaces multiples réduits).
 */
function resolvePropertyKey(properties: Record<string, any>, candidates: string[]): string | null {
  const normalizedMap = new Map<string, string>()
  for (const realKey of Object.keys(properties)) {
    normalizedMap.set(normalizeKey(realKey), realKey)
  }
  for (const candidate of candidates) {
    const found = normalizedMap.get(normalizeKey(candidate))
    if (found) return found
  }
  return null
}

function getTitleValue(properties: Record<string, any>, candidates: string[]): string | null {
  const key = resolvePropertyKey(properties, candidates)
  if (!key) return null
  const prop = properties[key]
  if (!prop || prop.type !== 'title') return null
  const arr = prop.title as Array<{ plain_text?: string }>
  if (!Array.isArray(arr) || arr.length === 0) return null
  const text = arr.map((t) => t.plain_text || '').join('').trim()
  return text || null
}

function getUrlValue(properties: Record<string, any>, candidates: string[]): string | null {
  const key = resolvePropertyKey(properties, candidates)
  if (!key) return null
  const prop = properties[key]
  if (!prop) return null
  if (prop.type === 'url') {
    const url = (prop.url || '').trim()
    return url || null
  }
  // Repli : certaines colonnes "URL" ont pu être re-typées en texte enrichi
  if (prop.type === 'rich_text') {
    const arr = prop.rich_text as Array<{ plain_text?: string }>
    if (Array.isArray(arr) && arr.length > 0) {
      const text = arr.map((t) => t.plain_text || '').join('').trim()
      return text || null
    }
  }
  return null
}

function getRichTextValue(properties: Record<string, any>, candidates: string[]): string | null {
  const key = resolvePropertyKey(properties, candidates)
  if (!key) return null
  const prop = properties[key]
  if (!prop) return null
  if (prop.type === 'rich_text') {
    const arr = prop.rich_text as Array<{ plain_text?: string }>
    if (Array.isArray(arr) && arr.length > 0) {
      const text = arr.map((t) => t.plain_text || '').join('').trim()
      return text || null
    }
    return null
  }
  if (prop.type === 'number') {
    return prop.number != null ? String(prop.number) : null
  }
  return null
}

/** Gère indifféremment les colonnes de type `select` OU `status` Notion. */
function getSelectOrStatusValue(properties: Record<string, any>, candidates: string[]): string | null {
  const key = resolvePropertyKey(properties, candidates)
  if (!key) return null
  const prop = properties[key]
  if (!prop) return null
  if (prop.type === 'select') {
    return prop.select ? prop.select.name || null : null
  }
  if (prop.type === 'status') {
    return prop.status ? prop.status.name || null : null
  }
  if (prop.type === 'rich_text') {
    const arr = prop.rich_text as Array<{ plain_text?: string }>
    if (Array.isArray(arr) && arr.length > 0) {
      const text = arr.map((t) => t.plain_text || '').join('').trim()
      return text || null
    }
  }
  return null
}

/** Colonne "Fichier PDF" — type `files` Notion (fichier interne ou lien externe). */
function getFileUrlValue(properties: Record<string, any>, candidates: string[]): string | null {
  const key = resolvePropertyKey(properties, candidates)
  if (!key) return null
  const prop = properties[key]
  if (!prop) return null
  if (prop.type === 'files') {
    const files = prop.files as Array<any>
    if (Array.isArray(files) && files.length > 0) {
      const first = files[0]
      if (first.type === 'file' && first.file?.url) return first.file.url as string
      if (first.type === 'external' && first.external?.url) return first.external.url as string
    }
    return null
  }
  if (prop.type === 'url') {
    return (prop.url || '').trim() || null
  }
  return null
}

// -----------------------------------------------------------------------------
// Extraction de l'ID vidéo YouTube depuis une URL youtu.be/... ou youtube.com/...
// -----------------------------------------------------------------------------
export function extractYouTubeId(url: string | null): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    if (host === 'youtu.be') {
      const id = u.pathname.replace(/^\//, '').split('/')[0]
      return id || null
    }
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      if (u.pathname === '/watch') {
        return u.searchParams.get('v')
      }
      if (u.pathname.startsWith('/embed/')) {
        return u.pathname.split('/embed/')[1]?.split('/')[0] || null
      }
      if (u.pathname.startsWith('/shorts/')) {
        return u.pathname.split('/shorts/')[1]?.split('/')[0] || null
      }
    }
  } catch {
    // URL invalide : ignore
  }
  return null
}

/** Extrait le numéro de volume depuis un texte libre du type "volume 5". */
function extractVolumeNumber(volumeText: string | null): number | null {
  if (!volumeText) return null
  const match = volumeText.match(/(\d+)/)
  if (!match) return null
  const n = parseInt(match[1], 10)
  return Number.isFinite(n) ? n : null
}

// -----------------------------------------------------------------------------
// Candidats de noms de colonnes (par ordre de priorité)
// -----------------------------------------------------------------------------
const CANDIDATES = {
  titre: ['TITRE', 'Titre'],
  statut: ['Statut', 'Status'],
  thematique: ['Thématique', 'Thematique'],
  volume: ['Volume'],
  videoUrl: ['Liens Vidéos YouTube', 'Lien YouTube', 'Lien Vidéo YouTube', 'Liens Vidéo YouTube'],
  guideUrl: ['Lien du Guide Recommandé', 'Lien Guide Recommandé'],
  prixGuide: ['Prix Guide Recommandé', 'Prix du Guide Recommandé'],
  fichierPdf: ['Fichier PDF', 'PDF'],
}

// -----------------------------------------------------------------------------
// Mapping d'une page Notion brute -> NotionCard normalisée
// -----------------------------------------------------------------------------
function mapPageToCard(page: any): NotionCard {
  const properties = page.properties || {}

  const titre = getTitleValue(properties, CANDIDATES.titre) || 'Sans titre'
  const statut = getSelectOrStatusValue(properties, CANDIDATES.statut)
  const thematique = getSelectOrStatusValue(properties, CANDIDATES.thematique)
  const volumeLabel = getRichTextValue(properties, CANDIDATES.volume)
  const volumeNumber = extractVolumeNumber(volumeLabel)

  // Repli intelligent : tente d'abord la colonne principale, puis la
  // variante secondaire si la première est vide, en gardant la 1re valeur
  // NON-VIDE trouvée — sans jamais dédupliquer ni bloquer une URL répétée.
  let videoUrl: string | null = null
  for (const candidate of CANDIDATES.videoUrl) {
    videoUrl = getUrlValue(properties, [candidate])
    if (videoUrl) break
  }

  let guideUrl: string | null = null
  for (const candidate of CANDIDATES.guideUrl) {
    guideUrl = getUrlValue(properties, [candidate])
    if (guideUrl) break
  }

  const prixGuideRecommande = getRichTextValue(properties, CANDIDATES.prixGuide)
  const pdfUrl = getFileUrlValue(properties, CANDIDATES.fichierPdf)

  return {
    id: page.id,
    titre,
    statut,
    thematique,
    volumeLabel,
    volumeNumber,
    videoUrl,
    videoId: extractYouTubeId(videoUrl),
    guideUrl,
    prixGuideRecommande,
    hasPdf: !!pdfUrl,
    isNew: false, // calculé après tri, voir fetchPublishedVolumes
  }
}

function isPublished(card: NotionCard): boolean {
  return (card.statut || '').trim().toLowerCase() === 'publié'
}

function sortCardsDesc(cards: NotionCard[]): NotionCard[] {
  return [...cards].sort((a, b) => {
    const av = a.volumeNumber ?? -Infinity
    const bv = b.volumeNumber ?? -Infinity
    if (av !== bv) return bv - av
    // Repli stable : ordre alphabétique du titre si pas de numéro de volume
    return a.titre.localeCompare(b.titre)
  })
}

// -----------------------------------------------------------------------------
// Appel Notion : requête paginée sur la base de données
// -----------------------------------------------------------------------------
async function queryAllPages(databaseId: string, token: string): Promise<any[]> {
  const pages: any[] = []
  let cursor: string | undefined = undefined

  do {
    const res = await fetch(`${NOTION_API_BASE}/databases/${databaseId}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`Notion query failed: ${res.status} ${errText}`)
    }

    const data = (await res.json()) as { results: any[]; has_more: boolean; next_cursor: string | null }
    pages.push(...(data.results || []))
    cursor = data.has_more ? data.next_cursor || undefined : undefined
  } while (cursor)

  return pages
}

// -----------------------------------------------------------------------------
// API publique du module
// -----------------------------------------------------------------------------

/**
 * Renvoie les pages Notion BRUTES (format natif de l'API Notion), filtrées
 * pour ne conserver que Statut === "Publié". Utilisé par GET /api/notion.
 */
export async function fetchNotionRawPublished(databaseId: string, token: string): Promise<any[]> {
  const allPages = await queryAllPages(databaseId, token)
  const published = allPages.filter((page) => {
    const card = mapPageToCard(page)
    return isPublished(card)
  })
  return published
}

/**
 * Renvoie la liste normalisée des volumes publiés, triée par numéro de
 * Volume décroissant, avec le badge "isNew" appliqué sur les 4 premiers.
 */
export async function fetchPublishedVolumes(databaseId: string, token: string): Promise<NotionCard[]> {
  const allPages = await queryAllPages(databaseId, token)
  const cards = allPages.map(mapPageToCard).filter(isPublished)
  const sorted = sortCardsDesc(cards)
  sorted.forEach((card, idx) => {
    card.isNew = idx < 4
  })
  return sorted
}

/**
 * Récupère une page Notion précise par son ID et renvoie ses métadonnées
 * normalisées + l'URL S3 signée (temporaire) du PDF, si la fiche est publiée.
 */
export async function fetchPageWithPdfUrl(
  pageId: string,
  _databaseId: string,
  token: string
): Promise<NotionCardWithPdf | null> {
  const res = await fetch(`${NOTION_API_BASE}/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
    },
  })

  if (!res.ok) {
    if (res.status === 404) return null
    const errText = await res.text().catch(() => '')
    throw new Error(`Notion page fetch failed: ${res.status} ${errText}`)
  }

  const page = await res.json()
  const card = mapPageToCard(page)

  // Défense en profondeur : ne jamais servir un PDF d'une fiche non publiée.
  if (!isPublished(card)) return null

  const properties = page.properties || {}
  let pdfUrl: string | null = null
  for (const candidate of CANDIDATES.fichierPdf) {
    pdfUrl = getFileUrlValue(properties, [candidate])
    if (pdfUrl) break
  }

  return { card, pdfUrl }
}
