# tokpilote-backend
Backend sécurisé de TokPilote pour l'intégration avec l'API TikTok.

## MVP vidéo manuel

Dans le tableau de bord, créez un projet puis ouvrez **Montage manuel et MP4**.
Ajoutez des scènes PNG/JPEG dans leur ordre de lecture, avec leur durée en secondes.
Vous pouvez joindre une narration MP3 par projet. Le rendu se prévisualise dans
le navigateur et se télécharge via la session qui l'a demandé.

Le serveur démarre avec `npm start`. Utiliser Node.js 20 ou ultérieur ainsi que
`ffmpeg` (libx264 et AAC) et `ffprobe` dans le PATH. Sur la base cible, vérifier
la création de `video_projects` et `video_project_scenes`, puis appliquer
`video-render-migration-v2.sql` et `video-mvp-migration.sql`.

Sur Render, utiliser une origine de tableau de bord HTTPS de même origine que
l’API. Garder les paramètres OAuth et de session existants. Configurer
`DATABASE_URL` et `SESSION_SECRET` dans Render, puis les variables suivantes :

- `VIDEO_MVP_ENABLED=true`, `VIDEO_RENDER_ENABLED=true`,
  `VIDEO_RENDER_PRODUCTION_ENABLED=true` et `VIDEO_RENDER_ALLOWED_ORIGIN`
  égal à l’origine HTTPS exacte du tableau de bord, sans barre finale.
- Conserver `VIDEO_RENDER_IMAGE_SOURCE` à sa valeur historique. Les nouveaux
  projets manuels détectés en base utilisent `VIDEO_MVP_IMAGE_DIRECTORY`,
  `VIDEO_MVP_AUDIO_DIRECTORY` et `VIDEO_MVP_OUTPUT_DIRECTORY` sous le disque persistant.
  Utiliser une seule instance. Les jetons en mémoire expirent après 15 minutes
  ou au redémarrage.

Voir [la procédure Render MVP](render-mvp-runbook.md) pour les commandes de
préproduction, les variables d’environnement et le retour arrière.

Pour une image de déploiement Render personnalisée, installer FFmpeg dans
l’image d’exécution et exécuter `npm ci --omit=dev` avant `npm start`.
Vérifier les droits du compte de service sur le disque et planifier la
purge des médias et rendus avant d’ouvrir le service largement.

Le test `node test-integration/video-mvp-e2e.js` se lance depuis la racine du
projet, avec un PostgreSQL de test sur `127.0.0.1:55439`, base
`videapilot_mvp`, utilisateur `postgres`. Il injecte des sessions signées
uniquement dans cette base isolée et ne requiert aucun appel TikTok ou IA.
Avec Node.js 22 ou ultérieur, passer le chemin de Edge ou Chromium en argument
pour exercer les formulaires dans le navigateur. L’option `--production-auth`
teste les gardes d’origine HTTPS via un proxy simulé sur localhost.
