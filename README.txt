DooBiiE's Chain Manager - Cloudflare Backend v0.4.0
=====================================================

WHAT CHANGED
------------
- Supports an allow-list of Torn faction IDs.
- The restriction is enforced by the Cloudflare backend, not the userscript.
- A user cannot bypass it just by editing their local userscript.
- Includes the chain-timer reset fix from v0.3.1.

FACTION RESTRICTION
-------------------
Open wrangler.jsonc and find:

  "ALLOWED_FACTION_IDS": ""

Examples:

Allow only one faction:
  "ALLOWED_FACTION_IDS": "12345"

Allow several factions:
  "ALLOWED_FACTION_IDS": "12345,67890,24680"

Leave it empty to allow any faction:
  "ALLOWED_FACTION_IDS": ""

Spaces, commas and semicolons are accepted as separators.

DEPLOYMENT WITH YOUR EXISTING GITHUB -> CLOUDFLARE SETUP
--------------------------------------------------------
1. Replace these files in your GitHub Torn-chain-manager repository:
   - src/index.js
   - wrangler.jsonc
   - package.json

2. Set ALLOWED_FACTION_IDS in wrangler.jsonc before committing.

3. Commit the changes to main.

4. Cloudflare should automatically run:
     npx wrangler deploy

5. Test:
   https://YOUR-WORKER.workers.dev/health

A restricted backend will report:
  "restricted": true
  "allowed_faction_count": 1

SECURITY NOTE
-------------
Torn API keys are used during authentication but are not stored in the faction
queue. The allow-list is checked again when opening the live WebSocket.
