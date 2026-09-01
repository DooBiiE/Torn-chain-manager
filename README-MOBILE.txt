DooBiiE's Chain Manager - Cloudflare backend (mobile-ready)

These are the Cloudflare Worker files. They REPLACE the old PHP/MySQL backend.
Do not upload the PHP or SQL files to Cloudflare.

Folder layout to keep in GitHub:

  package.json
  wrangler.jsonc
  src/
    index.js

The worker name is already set to:
  torn-chain-manager-doobiie

Recommended Android deployment route:
1. Create a new GitHub repository (or a backend folder in a repo).
2. Upload package.json and wrangler.jsonc to the repository root.
3. Create a folder named src and upload index.js into src.
4. In Cloudflare open your existing Worker: torn-chain-manager-doobiie.
5. Open Settings -> Builds and connect the GitHub repository.
6. Production branch: main.
7. Deploy command: npx wrangler deploy
8. Save/deploy.
9. When deployment finishes, test:
   https://torn-chain-manager-doobiie.john-dobinson92.workers.dev/health

Expected response contains:
  "ok": true
  "service": "DooBiiE's Chain Manager backend"

ALLOWED_FACTION_ID is blank for the first trial. Once everything works, it can be
set to your faction ID to stop members of other factions using this backend.
