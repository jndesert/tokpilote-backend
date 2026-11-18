# VidéaPilot · Préproduction Render

Le dépôt fournit un backend Node et `npm start`. Il ne contient pas de Blueprint
Render pour ce service. Avant toute action distante, relever le service, le dépôt,
la branche, le runtime, le disque et les modes de stockage dans le tableau Render,
sans copier les valeurs secrètes dans les logs.

## Ressources isolées à préparer sur autorisation

- Un **Web Service Node natif**, une seule instance, même région que sa base.
  Relier la branche de livraison du dépôt backend. Désactiver les déploiements
  automatiques pendant la mise en place.
- Un **PostgreSQL de préproduction distinct**. Utiliser son URL interne. Pour
  tester S3, utiliser un bucket ou compte de préproduction et des données de test.
- Un **disque persistant Render monté à `/var/data`**, par exemple 10 Go au
  départ. Les sous-dossiers sont créés au démarrage, jamais au build.
- Une application TikTok de test ou un callback de préproduction explicitement
  autorisé. Le domaine public et le callback actuel restent en place.

## Variables

| Variable | Valeur attendue |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL`, `SESSION_SECRET` | URL de la base cible et secret fort propres à cet environnement, saisis dans Render |
| `VIDEO_MVP_ENABLED`, `VIDEO_RENDER_ENABLED`, `VIDEO_RENDER_PRODUCTION_ENABLED` | `true` après accord explicite |
| `VIDEO_RENDER_ALLOWED_ORIGIN` | Origine HTTPS exacte du backend qui sert `/dashboard`, sans barre finale |
| `VIDEO_MVP_IMAGE_DIRECTORY`, `VIDEO_MVP_AUDIO_DIRECTORY`, `VIDEO_MVP_OUTPUT_DIRECTORY` | `/var/data/images`, `/var/data/audio`, `/var/data/output` |
| `VIDEO_IMAGE_DIRECTORY`, `VIDEO_AUDIO_DIRECTORY`, `VIDEO_OUTPUT_DIRECTORY` | Conserver les chemins historiques. |
| `VIDEO_RENDER_IMAGE_SOURCE` | Garder la valeur historique, par exemple `s3`. Les projets manuels marqués en base utilisent le disque. |
| `MEDIA_STORAGE_ENABLED`, `MEDIA_STORAGE_REGION`, `MEDIA_STORAGE_ENDPOINT`, `MEDIA_STORAGE_BUCKET`, `MEDIA_STORAGE_ACCESS_KEY_ID`, `MEDIA_STORAGE_SECRET_ACCESS_KEY` | Valeurs existantes pour S3 historique. En préproduction, renseigner uniquement des valeurs de test. |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | Application TikTok de l’environnement, valeurs secrètes dans Render |
| `TIKTOK_REDIRECT_URI` | En préproduction, `<origine HTTPS>/auth/tiktok/callback`, enregistré chez TikTok. En production, laisser le réglage vide pour conserver le callback historique. |
| `VIDEO_RENDER_TOKEN_STORAGE` | `memory` ou absent, une seule instance |
| `VIDEO_RENDER_LOCAL_TEST`, `VIDEAPILOT_LOCAL_READONLY` | Absents sur Render |

Render fournit `PORT`. Le proxy et les sessions restent ceux du serveur existant.
Le site `videapilot.fr` doit diriger vers le tableau de bord HTTPS existant.
Les requêtes vidéo passent sur la même origine que ce tableau de bord.

## Commandes Render

Build, depuis la racine du dépôt backend :

```sh
npm ci --omit=dev && ffmpeg -version && ffprobe -version
```

Pré-déploiement, **sur base isolée neuve uniquement** :

```sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f video-mvp-bootstrap.sql -f video-render-migration-v2.sql -f video-mvp-migration.sql
```

Sur une base existante, après sauvegarde et inspection du schéma, omettre
`video-mvp-bootstrap.sql`. Les deux autres scripts sont transactionnels et
réexécutables. La migration MVP ajoute des colonnes et ne reclasse aucun
projet existant. Le MVP antérieur n’ayant pas été déployé, il ne faut pas
reclasser des projets historiques par déduction à partir des noms de fichiers.

Démarrage et contrôle de santé :

```sh
node render-mvp-start.js
curl --fail --silent --show-error https://<hote-backend>/health
```

Le démarrage en mode MVP vérifie le montage effectif du disque, les droits,
les colonnes PostgreSQL et la présence de `libx264`, AAC et `ffprobe`.
Le chemin de contrôle de santé Render est `/health`. Si les codecs manquent
dans le runtime natif réel, utiliser une image Docker avec FFmpeg testé avant
de procéder au déploiement.

## Validation et retour arrière

1. Inclure dans le commit de livraison le tableau de bord et les modules de
   rendu déjà présents localement mais encore non suivis, en particulier
   `video-mvp-*`, `video-render-s3-adapter.js`,
   `video-render-download-{storage-selector,token-adapter,token-store}.js`,
   `video-render-mp4-storage-adapter.js`,
   `video-render-r2-http-response.js` et `video-render-storage-metadata.js`.
   Ne pas ajouter les sauvegardes, médias de test ou fichiers d’environnement.
2. Déployer manuellement le commit sur le service isolé après accord.
   Vérifier la connexion TikTok, le parcours complet et le rendu d’un
   projet S3 de test. Vérifier la lecture HTTP 206 et le téléchargement 200.
   Redémarrer et vérifier la persistance des scènes et la perte attendue du
   jeton de téléchargement. Les fichiers sur disque sont conservés.
3. Sur incident, désactiver `VIDEO_MVP_ENABLED`, restaurer les autres variables
   à leurs valeurs précédentes et revenir au dernier déploiement stable.
   Conserver les colonnes ajoutées et le disque. Une suppression de colonnes,
   une conversion des nouveaux projets locaux ou un détachement du disque
   se traite séparément avec sauvegarde et autorisation.

Un disque Render réserve ce montage à une seule instance et entraîne une
brève interruption lors d’un redéploiement. Prévoir un contrôle de capacité
et une politique de rétention avant ouverture large.
