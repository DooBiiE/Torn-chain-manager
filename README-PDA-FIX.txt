DooBiiE's Chain Manager backend v0.4.1

Adds an authenticated HTTP fallback for Torn PDA while keeping WebSockets
for desktop.

With your existing GitHub -> Cloudflare setup:
1. Replace src/index.js and package.json in GitHub.
2. Keep your existing wrangler.jsonc so your ALLOWED_FACTION_IDS value stays intact.
3. Commit to main.
4. Wait for Cloudflare to finish deploying.
5. /health should report backend version 0.4.1.
