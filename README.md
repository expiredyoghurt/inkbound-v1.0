# Inkbound: The Last Atlas — v2.2 — Firebase Package

## What's new in v2.2

See `CHANGELOG.md` for full detail. Short version:

- **First-session tutorial** — a one-time 4-step walkthrough (Atlas &
  Stability, Workshop/Airship loop, Regatta & Class Standings, streak
  bonuses) shown on a Mender's very first login. Tracked via
  `hasSeenTutorial` on the account record (syncs like everything else);
  guests get it in-memory only, once per guest session. Re-openable any
  time via a "❔ Show Tutorial Again" link on the Airship screen.
- **`lastActiveAt` per Mender** — stamped on login and every save,
  surfaced as "X days ago" in the admin Menders pane, Bulk Actions
  dropdown, and Fleet View, all three now sortable by it. Deliberately
  built to be decay-mechanic-ready (same epoch-ms shape as the existing
  per-region `lastActiveAt`) if/when that ships.

## What's new in v2.1

- **ink-explainers.js integrated** into `index.html` (inlined, still one
  file) — 6 of 8 question mechanics now get schema-driven explainers via
  the module first, falling back to the original explainer system with
  zero re-authoring needed. 3 mechanics (restoration_bench,
  alchemists_forge, oracles_chamber) intentionally stay on the original
  system — see `CHANGELOG.md` for why.
- **Bug fix: repeat-submission exploit.** On 7 of 9 regions, clicking
  Submit repeatedly on the same rendered question (no navigation
  in-between) re-ran `grantReward()` every time — farming resources,
  stability, and streak bonuses for free. All 6 affected `onclick`
  handlers now disable the button on first click with a defensive
  `if (submitBtn.disabled) return;` guard. Verified with a standalone
  functional test (5 simulated clicks → 1 `grantReward` call) in
  addition to reading the code. Plain MCQ (checkpoint_gates, bazaar) was
  already safe — its option buttons are natively disabled synchronously
  — and was left untouched as a regression control.
- Firebase + Cloudflare KV dual sync, AI marking for the Oracle's
  Chamber, and the status icon pair (all from the prior pass) — unchanged.

## 1. Syntax check results

I pulled the game's single `<script>` block (4,757 lines) out of the HTML and ran
it through Node's parser (`node --check`), and separately verified the static
HTML shell (tags, `<script>`/`<style>` blocks). **No errors found.**

- JavaScript: parses clean, zero syntax errors.
- HTML shell: `<html>`, `<head>`, `<body>`, all 4 `<script>` tags, and every
  `<div>`/`<span>`/`<button>` in the static markup are balanced. (Most of the
  UI is built dynamically by your `render*()` functions via template
  literals, which is normal for this kind of single-file app and isn't
  something a static tag count can fully verify — but nothing in there
  raised a flag either.)
- The file already has Firebase compat SDK `<script src>` tags loaded, a
  `FIREBASE_CONFIG` placeholder, `FIREBASE_ENABLED` feature-detection, and
  `fbPushDoc` / `fbListenDoc` helpers wired into 8 sync doc IDs
  (`accounts`, `teacherAccounts`, `ocOverrides`, `regionBankOverrides`,
  `workshopCostOverrides`, `stabilityConfig`, `regattaConfig`,
  `classStandingsConfig`). Your comment block says `firestore.rules` ships
  alongside the file — it wasn't in the upload, so I've written one that
  matches the security model you described in that comment (see below).

No code changes were needed or made — `public/index.html` is byte-identical
to the file you uploaded.

## 2. What's in this package

```
inkbound-deploy/
├── public/
│   └── index.html          ← your game (see note below — one small addition)
├── firestore.rules         ← Firestore security rules (new — see below)
├── firestore.indexes.json  ← empty indexes file (Firestore needs this to exist)
├── firebase.json           ← Hosting + Firestore config
├── .firebaserc.template    ← rename to .firebaserc and fill in your project ID
├── worker/
│   ├── worker.js           ← Cloudflare Worker: KV-backed sync API
│   ├── wrangler.toml       ← optional, only needed for CLI deploys
│   └── README.md           ← browser-only deploy guide for Worker + KV + Pages
└── README.md               ← this file
```

**Note on `index.html`**: it's your file with three additive changes,
none of which touch Firebase-only usage:

1. `fbPushDoc`/`fbListenDoc` (the two functions every sync call site
   already uses) now fan out to Cloudflare KV as well as Firebase, if
   you configure it.
2. The Oracle's Chamber (open-ended comprehension) now tries AI marking
   first — judging whether a student's answer means the same thing as
   the sample answer, not exact wording — before falling back to the
   original keyword matcher if AI marking isn't configured or fails.
   See `worker/README.md` section 6 for setup (Gemini → Groq → xAI →
   Cloudflare Workers AI, in that order).
3. Two small status icon pills now sit fixed in the top-right corner:
   a cloud (sync status) and a crystal ball (AI marking status). See
   `worker/README.md` section 7 for what each state means.

See `worker/README.md` if you want to add the Cloudflare backend, AI
marking, both, or neither. Ran `node --check` on the script after every
change — still zero syntax errors throughout.

`firestore.rules` implements exactly what your in-file comment promised:
**any signed-in user (including anonymous) can read/write the
`inkboundSync` collection**, everything else is denied. This keeps random
internet traffic off your database without a full per-student auth system —
it does *not* stop one Mender from editing another's data or touching admin
config, same as the rest of the app's plaintext/client-side model.

## 3. Set up the Firebase project — all in your browser

1. Go to **console.firebase.google.com** and click **Add project**. Name it
   whatever you like (e.g. `inkbound-atlas`). You can decline Google
   Analytics — you don't need it.
2. In the left sidebar: **Build → Firestore Database → Create database**.
   Choose a region close to Singapore (e.g. `asia-southeast1`), and start in
   **production mode** (the rules file below will govern access either way).
3. In the left sidebar: **Build → Authentication → Get started**. On the
   **Sign-in method** tab, enable **Anonymous**. This is what lets the game
   silently sign every visitor in so Firestore rules see `request.auth != null`.
4. Still in Firebase Console: click the **gear icon → Project settings**,
   scroll to **Your apps**, click the **`</>`** (web) icon, give it a
   nickname (e.g. "Inkbound Web"), and **do not** check "Also set up
   Firebase Hosting" here — you already have `firebase.json` in this
   package. Click **Register app**.
5. Copy the `firebaseConfig` object it shows you. Open
   `public/index.html`, find this block near the top of the `<script>`
   section (search for `FIREBASE_CONFIG`):

   ```js
   const FIREBASE_CONFIG = {
     apiKey: "PASTE_YOUR_FIREBASE_API_KEY",
     authDomain: "YOUR_PROJECT.firebaseapp.com",
     projectId: "YOUR_PROJECT_ID",
     storageBucket: "YOUR_PROJECT.appspot.com",
     messagingSenderId: "YOUR_SENDER_ID",
     appId: "YOUR_APP_ID"
   };
   ```

   and paste in your real values. (Leaving `apiKey` as the placeholder is
   fine too — the game just runs local-only/per-browser with no sync, as
   the in-file comment explains.)
6. Rename `.firebaserc.template` to `.firebaserc` and replace
   `YOUR_PROJECT_ID` with your actual Firebase project ID (shown at the top
   of Project settings).

## 4. Deploy — entirely from the browser (no local install)

Firebase Hosting and Firestore rules are normally deployed with the
Firebase CLI, which usually means installing Node.js on your computer. You
can skip that entirely by using **Google Cloud Shell**, a terminal that
runs inside your browser and comes with the Firebase CLI already
installed:

1. In Firebase Console, click your project, then the **`>_` Cloud Shell**
   icon near the top-right of the console (or go to
   `console.cloud.google.com`, select your project, and click the same
   icon). A terminal panel opens at the bottom of the browser window — this
   is a real Linux machine, but it's Google's, not yours.
2. Upload this whole `inkbound-deploy` folder into Cloud Shell: click the
   **⋮ (more)** menu in the Cloud Shell panel → **Upload folder**, and
   select `inkbound-deploy`. (If your browser only allows uploading
   individual files, zip the folder first and upload the zip, then run
   `unzip inkbound-deploy.zip` in the Cloud Shell terminal.)
3. In the Cloud Shell terminal, run:

   ```bash
   cd inkbound-deploy
   firebase login --no-localhost
   ```

   It'll print a URL — open it in a browser tab, sign in with the same
   Google account you used for the Firebase project, and paste the
   confirmation code back into Cloud Shell.
4. Deploy everything:

   ```bash
   firebase deploy --project YOUR_PROJECT_ID
   ```

   (or just `firebase deploy` if you've already renamed `.firebaserc.template`
   to `.firebaserc` with your project ID filled in). This pushes both the
   Firestore rules and the Hosting site in one command.
5. When it finishes, it prints a **Hosting URL** — something like
   `https://YOUR_PROJECT_ID.web.app`. That's the live game.

Everything above happens inside browser tabs — no software touches your
own laptop.

### If you'd rather not use Firebase Hosting at all

Firestore is the only Firebase piece the game actually needs — Hosting is
just "somewhere to put the HTML file." Since `index.html` is fully
self-contained, you can instead host it exactly like your other projects
(Cloudflare Pages, or even just distributing the file for teachers/students
to open directly) and it'll still sync through Firestore as long as steps
1–3 above are done and the config is pasted in. In that case you can skip
section 4 entirely and just run `firebase deploy --only firestore` from
Cloud Shell (same steps 1–4, swap the last command) to publish the rules,
which is the one Firebase piece that *does* need a real deploy step.

## 5. Test it

1. Open the Hosting URL (or your `index.html` wherever you host it) in two
   different browsers (or one normal + one incognito window).
2. Log into the admin panel with `palpatine` / `Order-66`, make an
   admin-side edit (e.g. a question bank override), and confirm it shows up
   in the other window without refreshing anything but the Firebase page —
   that's `fbListenDoc` doing live sync.
3. In Firebase Console → Firestore Database, you should see an
   `inkboundSync` collection appear with docs named `accounts`,
   `teacherAccounts`, etc. as the game writes to them.
4. The beta-tester login (`kirito` / `Beater`) still works the same as
   local-only mode — it's a client-side shortcut, not something that needs
   Firestore.

## 6. Notes / things worth knowing

- **Cost**: Firestore's free tier (Spark plan) covers a single class using
  this comfortably — reads/writes for a few dozen students is far under the
  daily free quota. No billing setup needed unless you scale way up.
- **No server code, no Cloud Functions**: everything is client-side, so
  there's nothing else to deploy beyond Hosting + Firestore rules.
- **Rotate `ADMIN_KEY`/`ADMIN_ID_LOWER`** before handing this out widely if
  you're worried about students poking at the admin panel — they're plain
  constants near the top of the script (`ADMIN_ID_LOWER`, `ADMIN_KEY`), easy
  to find-and-replace.
- If you ever want tighter Firestore rules (e.g. only the teacher device can
  write config docs), that requires moving off anonymous auth to something
  with real identity — happy to help design that if you want it later.
