import { jsxRenderer } from 'hono/jsx-renderer'

export const renderer = jsxRenderer(({ children }) => {
  return (
    <html lang="fr">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
        <meta name="color-scheme" content="dark light" />
        {/* -----------------------------------------------------------------
            ANTI-FLASH THÈME : applique le thème mémorisé (localStorage)
            AVANT le premier paint, en script bloquant inline placé en tout
            premier dans <head>. Évite tout flash de thème sombre->clair au
            chargement de la page. Thème par défaut : "dark" (sombre, style
            original) si aucune préférence n'est encore enregistrée.
            ----------------------------------------------------------------- */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme')||'dark';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`,
          }}
        />
        <title>Résumés &amp; Guides PDF Gratuits de nos Vidéos — PsychoFéminine</title>
        <meta
          name="description"
          content="Téléchargez gratuitement le résumé PDF de nos vidéos et accédez au guide recommandé pour aller plus loin."
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Sora:wght@600;700;800&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" />
        <link href="/static/style.css" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  )
})
