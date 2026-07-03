# Déployer DriveAura — Render (backend) + Netlify (frontend)

## ⚠️ Avant tout : change tes clés

Tu as partagé tes clés en clair dans le chat (mot de passe admin, JWT, MongoDB, Cloudinary, Groq, Google, OpenRouter). Ces clés doivent être considérées comme grillées. Avant de déployer :

1. **MongoDB Atlas** : change le mot de passe de l'utilisateur `compteachat78_db_user` (Database Access → Edit → Edit Password).
2. **Cloudinary** : régénère ton API secret (Settings → Security → régénérer).
3. **Groq / Google AI Studio / OpenRouter** : supprime les clés actuelles et recrée-en de nouvelles.
4. **ADMIN_PASSWORD / JWT_SECRET / ADMIN_SECRET_PATH** : choisis de nouvelles valeurs, ne réutilise pas celles déjà partagées.

Aucune valeur ci-dessous n'est réutilisée — tu dois générer/copier tes propres valeurs directement dans Render, jamais dans un fichier du dépôt.

## Bugs corrigés dans cette version

1. **Toutes les requêtes API étaient cassées côté frontend.** Dans `public/index.html` et `public/admin.html`, chaque appel `fetch`/`EventSource` écrivait `` `\${API_URL}/...` `` au lieu de `` `${API_URL}/...` ``. Le `\` empêchait l'interprétation de la variable : le navigateur appelait littéralement l'URL `${API_URL}/api/...`, donc **aucun appel réseau ne fonctionnait** (connexion admin, tarifs, paiement, soumission de dossier, suivi, WhatsApp). Corrigé partout.
2. **Erreur de syntaxe JavaScript** dans `public/index.html` (`fetch(\`${API_URL}/api/dossiers/status/${id});` — backtick de fermeture manquant). Cette erreur cassait tout le script de la page, pas seulement le suivi de dossier. Corrigée.
3. **URL non configurable** dans `public/admin.html` — le bouton valider/rejeter appelait `/api/dossiers/...` en relatif au lieu de `${API_URL}/api/dossiers/...`. Ça fonctionnait seulement si le frontend et le backend étaient sur le même domaine ; cassé dès que l'admin est hébergé sur Netlify séparément. Corrigé.
4. Le reste du fichier `server.js` était déjà correct dans la version que tu m'as donnée (garde-fou `JWT_SECRET` obligatoire, rate limit sur le login, CORS configurable, route des tarifs). Je l'ai gardé tel quel.

## Deux façons de déployer

### Option A — Tout sur Render (le plus simple)

Le serveur sert déjà les fichiers HTML depuis `public/`. Tu peux déployer uniquement sur Render et ignorer Netlify.

1. Mets `public/config.js` avec `const API_URL = '';` (déjà la valeur par défaut dans cette version).
2. Suis la section "Déployer sur Render" ci-dessous.
3. Ton site est disponible directement à l'URL Render (ex: `https://driveaura-api-1.onrender.com`).

### Option B — Backend sur Render + Frontend sur Netlify (séparés)

Utile si tu veux un nom de domaine propre pour le site public et garder l'API à part.

1. Déploie d'abord le backend sur Render (section suivante) et note son URL, ex: `https://driveaura-api-1.onrender.com`.
2. Dans `public/config.js`, mets :
   ```js
   const API_URL = 'https://driveaura-api-1.onrender.com';
   ```
3. Déploie le dossier `public/` sur Netlify (section "Déployer sur Netlify").
4. Sur Render, ajoute la variable `ALLOWED_ORIGINS` avec l'URL Netlify (ex: `https://driveaura.netlify.app`) pour autoriser les appels cross-origin.

---

## Déployer sur Render (backend)

1. Pousse ce dossier (`server.js`, `package.json`, `public/`, etc.) sur un dépôt GitHub. **Ne commite jamais `.env`** — il est déjà ignoré par `.gitignore`.
2. Sur [render.com](https://render.com) → **New +** → **Web Service** → connecte le dépôt GitHub.
3. Configuration du service :
   - **Environment** : `Node`
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** : Free suffit pour démarrer (le plan gratuit s'endort après inactivité — la première requête après veille sera lente).
4. Dans l'onglet **Environment** du service Render, ajoute ces variables (valeurs à toi, ne pas réutiliser celles déjà partagées) :

   | Variable | Description |
   |---|---|
   | `NODE_ENV` | `production` |
   | `MONGODB_URI` | Ta chaîne de connexion MongoDB Atlas |
   | `JWT_SECRET` | Nouvelle chaîne aléatoire longue (64+ caractères) |
   | `ADMIN_EMAIL` | Email de connexion au cockpit admin |
   | `ADMIN_PASSWORD` | Nouveau mot de passe admin |
   | `ADMIN_SECRET_PATH` | Nouveau chemin secret pour accéder à `/admin.html` (ex: `/tonchemin`) |
   | `CLOUDINARY_CLOUD_NAME` | Depuis ton dashboard Cloudinary |
   | `CLOUDINARY_API_KEY` | Depuis ton dashboard Cloudinary |
   | `CLOUDINARY_API_SECRET` | Nouveau secret régénéré |
   | `GROQ_API_KEY` | Nouvelle clé Groq |
   | `GOOGLE_API_KEY` | Nouvelle clé Google AI Studio |
   | `OPENROUTER_API_KEY` | Nouvelle clé OpenRouter |
   | `ALLOWED_ORIGINS` | Ton domaine Netlify si tu utilises l'Option B, sinon laisse vide |

   Render fournit automatiquement `PORT` — pas besoin de le définir toi-même.

5. Clique **Create Web Service**. Render build et démarre l'app, puis te donne une URL du type `https://ton-service.onrender.com`.
6. Vérifie que ça tourne en ouvrant `https://ton-service.onrender.com` dans le navigateur.

**Note WhatsApp (Baileys)** : le plan gratuit de Render redémarre le service régulièrement et n'a pas de disque persistant, donc la session WhatsApp scannée par QR code sera perdue à chaque redémarrage/veille. Pour une connexion WhatsApp stable, il faut un plan payant avec un disque persistant (Render Disk) monté sur `.baileys-auth/`.

---

## Déployer sur Netlify (frontend, uniquement si Option B)

1. Sur [netlify.com](https://netlify.com) → **Add new site** → **Import an existing project** → connecte le même dépôt GitHub (ou un dépôt séparé ne contenant que le dossier `public/`).
2. Configuration du build :
   - **Base directory** : laisse vide si tu déploies uniquement le contenu de `public/`, sinon mets `public`
   - **Build command** : laisse vide (site statique, pas de build)
   - **Publish directory** : `public` (ou `.` si tu as déployé seulement ce dossier)
3. Netlify n'a pas besoin de variables d'environnement ici puisque `public/config.js` contient déjà l'URL du backend Render en dur.
4. Une fois déployé, Netlify te donne une URL du type `https://ton-site.netlify.app`.
5. Retourne sur Render et mets à jour `ALLOWED_ORIGINS` avec cette URL exacte pour que le CORS autorise les appels du frontend vers l'API.

---

## Checklist finale

- [ ] Toutes les clés ont été régénérées (MongoDB, Cloudinary, Groq, Google, OpenRouter)
- [ ] Nouveau `ADMIN_PASSWORD`, `JWT_SECRET`, `ADMIN_SECRET_PATH` choisis
- [ ] Variables ajoutées dans Render (jamais dans un fichier commité)
- [ ] `public/config.js` pointe vers la bonne URL (`''` si tout-en-un sur Render, ou l'URL Render si Netlify séparé)
- [ ] `ALLOWED_ORIGINS` sur Render inclut l'URL Netlify si tu utilises l'Option B
- [ ] Cockpit admin testé via `https://ton-backend/TON_ADMIN_SECRET_PATH`
- [ ] Soumission d'un dossier test depuis le site public pour vérifier l'upload Cloudinary et MongoDB
