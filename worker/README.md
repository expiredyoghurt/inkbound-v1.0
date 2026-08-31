# Inkbound — Cloudflare Worker + KV sync backend

This gives the game a second (or alternative) real-time-ish sync backend,
mirroring what the Firebase block already does — same 8 doc IDs
(`accounts`, `teacherAccounts`, `ocOverrides`, `regionBankOverrides`,
`workshopCostOverrides`, `stabilityConfig`, `regattaConfig`,
`classStandingsConfig`), just stored in Cloudflare KV instead of
Firestore, and polled every 4 seconds instead of pushed live (KV has no
realtime subscribe, unlike Firestore).

`index.html` already has the client side of this wired in
(`CF_WORKER_CONFIG`, `cfPushDoc`, `cfListenDoc`) — you only need to deploy
the Worker below and paste its URL in. **You can use this instead of
Firebase, alongside it, or skip it and leave Firebase as your only
backend** — whichever config has a real (non-placeholder) value gets used.

## 1. Create the KV namespace (browser, dashboard)

1. Go to **dash.cloudflare.com** → **Workers & Pages** → **KV** (left
   sidebar) → **Create a namespace**.
2. Name it `INKBOUND_KV` and click **Add**.

## 2. Create the Worker and paste in the code (browser, dashboard)

1. **Workers & Pages** → **Create** → **Workers** → **Create Worker**.
2. Give it a name, e.g. `inkbound-sync`. Click **Deploy** to scaffold it
   (it'll deploy a placeholder "Hello World" — that's fine, you're about
   to replace it).
3. Click **Edit code** (opens the browser-based Quick Edit editor).
4. Select all the placeholder code and delete it, then paste in the
   contents of `worker/worker.js` from this package.
5. Click **Deploy** (top right) to publish your changes.

## 3. Bind the KV namespace to the Worker (browser, dashboard)

1. Go back to your Worker's page → **Settings** tab → **Variables and
   Bindings** (sometimes labelled **Bindings**).
2. Click **Add binding** → **KV Namespace**.
3. Set **Variable name** to exactly `INKBOUND_KV` (must match the name
   `worker.js` looks for) and **KV namespace** to the one you created in
   step 1. Save.

## 4. (Optional) Add a shared secret

If you want to stop random people from writing to your KV namespace even
if they find the Worker's URL:

1. Same **Variables and Bindings** section → **Add** → **Secret**.
2. Name it exactly `WORKER_SYNC_KEY`, value = any password you make up.
   Save.
3. Back in `index.html`, set `CF_WORKER_CONFIG.syncKey` to the same value.

Leave this step out entirely and the endpoint stays open — same "keeps
randoms off, not real per-student auth" spirit as the Firestore rules
from the Firebase package.

## 5. Point the game at your Worker

1. Copy your Worker's URL — shown at the top of its dashboard page,
   looks like `https://inkbound-sync.YOUR-SUBDOMAIN.workers.dev`.
2. Open `public/index.html`, find `CF_WORKER_CONFIG` near the top of the
   `<script>` block (same area as `FIREBASE_CONFIG`), and paste it in:

   ```js
   const CF_WORKER_CONFIG = {
     baseUrl: "https://inkbound-sync.YOUR-SUBDOMAIN.workers.dev",
     syncKey: "" // fill in only if you set WORKER_SYNC_KEY in step 4
   };
   ```

3. Test the Worker directly by visiting
   `https://inkbound-sync.YOUR-SUBDOMAIN.workers.dev/api/health` in a
   browser tab — you should see `{"ok":true,"kvBound":true,...}`. If
   `kvBound` is `false`, the binding in step 3 didn't save; redo it.

## 6. Turn on AI marking for the Oracle's Chamber (optional, dashboard)

The Oracle's Chamber (open-ended comprehension) can be graded by an LLM
instead of — or as a smarter fallback on top of — the built-in keyword
matcher. Unlike a rubric, it's judging **intent**: "does the student's
answer mean the same thing as the sample answer, given the passage?",
which is far more forgiving of kids who reason correctly but phrase it
differently.

This uses the SAME Worker as the KV sync above (`worker.js` already has
the `/api/grade-intent` route in it — nothing extra to deploy). It tries
providers in this order, first one that's configured and succeeds wins:

1. **Google Gemini**
2. **Groq**
3. **xAI (Grok)**
4. **Cloudflare Workers AI** — no external key needed, just a binding

You only need to set up as many of these as you want — even zero, in
which case the game quietly uses keyword marking as before.

### 6a. Google Gemini (first choice)

1. Go to **aistudio.google.com/app/apikey**, sign in, and create an API
   key.
2. Back in your Worker's dashboard page → **Settings** → **Variables
   and Bindings** → **Add** → **Secret**.
3. Name it exactly `GEMINI_API_KEY`, paste in the key, save.

### 6b. Groq (second choice)

1. Go to **console.groq.com/keys**, sign in, create an API key.
2. Same **Add → Secret** flow on the Worker → name it exactly
   `GROQ_API_KEY`.

### 6c. xAI / Grok (third choice)

1. Go to **console.x.ai**, sign in, create an API key.
2. Same flow → name it exactly `XAI_API_KEY`.

### 6d. Cloudflare Workers AI (final fallback — recommended minimum)

This one's worth setting up even if you configure the others, since it's
the option most likely to still work if an external provider has an
outage — and it needs no external account or key at all:

1. Worker's dashboard page → **Settings** → **Variables and Bindings** →
   **Add** → **AI**.
2. Name the binding exactly `AI`, save.

### Test it

Visit `https://YOUR-WORKER-URL/api/ai-health` in a browser tab. You
should see something like:

```json
{"ok":true,"providers":{"gemini":true,"groq":false,"xai":false,"workersAI":true},"active":"gemini"}
```

`active` shows which provider will actually be tried first. `index.html`
calls this same endpoint on load to light up its status icon (see
section 8 below) — no game-side config needed beyond `CF_WORKER_CONFIG`,
which you already set in section 5.

## 7. The two status icons at the top of the game

Once you've filled in `CF_WORKER_CONFIG` (and/or `FIREBASE_CONFIG`), two
small icon pills appear fixed in the top-right corner of the game:

- **☁️ Cloud icon** — reflects `syncStatus`: dim/off if no backend is
  configured, glowing gold while syncing, green once a save round-trips
  successfully, amber ⚠️ if a sync attempt failed (it'll keep retrying;
  the game still works fully offline off `localStorage` either way).
- **🔮 Oracle icon** — reflects AI marking: dim/off if no Worker is
  configured, gold while the initial `/api/ai-health` check is running,
  green once it confirms at least one provider is available, amber if
  the Worker is unreachable or no provider succeeded (Oracle's Chamber
  silently uses keyword marking in that case — nothing breaks for the
  student).

Hovering either icon shows a plain-language tooltip with the same
information, for anyone who wants more than "is it green."

## 8. Host the game itself on Cloudflare Pages (browser, dashboard)

The Worker above is just the sync API — you still need somewhere to serve
`index.html` itself. Since it's one self-contained file, drag-and-drop
Pages hosting is the fastest route and needs no CLI:

1. **Workers & Pages** → **Create** → **Pages** → **Upload assets**.
2. Give the project a name, then drag in `public/index.html` (rename it
   to `index.html` if it isn't already — Pages needs that exact name as
   the entry file).
3. Click **Deploy site**. You'll get a URL like
   `https://your-project.pages.dev` — that's the live game.

Because the Worker sets `Access-Control-Allow-Origin: *`, the Pages site
can call it regardless of which `.pages.dev` (or custom) domain it ends
up on — no CORS config needed on your end.

## 9. Test it

1. Open the Pages URL in two different browsers (or a normal + incognito
   window).
2. Log into the admin panel with `palpatine` / `Order-66` and make an
   edit (e.g. a question bank override).
3. Within ~4 seconds the other window should pick up the change (that's
   `cfListenDoc`'s poll interval) — refresh isn't required.
4. In the Cloudflare dashboard, **Workers & Pages → KV → INKBOUND_KV**,
   you should see keys appear matching the doc IDs as the game writes to
   them.

## Notes

- **AI marking cost**: only Oracle's Chamber submissions call an LLM —
  every other region is unchanged (still free, instant, client-side).
  Gemini/Groq/xAI all have free or cheap tiers that comfortably cover a
  class; Workers AI's free allocation is separate from and in addition
  to those. If you only want to run this at zero external cost, set up
  Workers AI (step 6d) alone and skip the API-key providers.
- **AI marking judges intent, not correctness of facts outside the
  passage** — it's told explicitly to compare the student's answer
  against the passage and sample answer, not to fact-check against the
  wider world, so it should stay consistent with what you'd expect from
  a comprehension exercise.
- **Fail-safe by design**: if the Worker is unreachable, every provider
  errors out, or a request times out (9s client-side), the game falls
  straight back to the original keyword matching — the Oracle's Chamber
  never blocks a student because of a network or API problem.


- **Free tier**: Workers' free plan (100,000 requests/day) and KV's free
  tier (100,000 reads + 1,000 writes/day) comfortably cover a single class
  polling every 4 seconds — do the math against your class size and
  session length if you're running many concurrent classes and want to
  confirm you're inside the free tier.
- **Polling vs. realtime**: this backend is polling-based, so changes take
  up to `CF_POLL_MS` (4000ms by default, adjustable in `index.html`) to
  show up on other devices — Firebase's `onSnapshot` is instant if you'd
  rather use that instead for a snappier admin-edit experience.
- **Running both backends at once**: harmless, but writes aren't merged —
  each backend just gets its own copy of whatever was last written through
  it. Fine for redundancy/testing; for a real deployment, pick one.
- **CLI alternative**: everything above uses the Cloudflare dashboard only.
  If you'd rather use `wrangler` from a terminal, `wrangler.toml` is
  included and `wrangler deploy` (after `wrangler kv namespace create
  INKBOUND_KV` and filling in its ID) does steps 1–3 in one command.
