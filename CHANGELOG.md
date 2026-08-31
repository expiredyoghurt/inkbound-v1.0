# Inkbound: The Last Atlas — Changelog

## v2.2

**1. First-session tutorial**

A one-time, 4-step stepper (`TUTORIAL_STEPS`) covering the Atlas map &
what Stability means, the Workshop/Airship upgrade loop, where Regatta
and Class Standings live, and the streak-bonus mechanic. Uses the same
`.modal-overlay`/`.modal-box` pattern already used by the session-summary
and claim-account modals, so it looks native rather than bolted on.

- **Registered Menders**: tracked via `hasSeenTutorial` on the account
  record (`getMenderAccounts()`), which already syncs via
  `saveMenderAccounts()` → `fbPushDoc("accounts", ...)` — so "seen it"
  follows a Mender across devices, not just this browser.
- **Guests**: tracked in-memory only (`guestTutorialSeenThisSession`),
  matching guests not persisting anything else. Shows once per guest
  session, resets naturally on the next one (new guest ID each time).
- **Beta tester**: skipped entirely — assumed to already know the game.
- Fires from `enterGame()`, the single funnel every login path (register,
  login, beta, guest) already routes through, so it can't be missed by
  covering one path and not another.
- Re-openable any time via a **"❔ Show Tutorial Again"** link on the
  Airship screen (`renderAirshipHero()`), for anyone who dismissed it too
  fast or just wants a refresher — doesn't touch `hasSeenTutorial`, so
  repeated opens never trigger multiple "first-time" side effects.

Verified with a standalone Node test of the gating logic
(`shouldShowTutorial`/`markTutorialSeen`) across all four session types
(new Mender, returning Mender, guest — same session and new session, beta
tester) before shipping.

**2. `lastActiveAt` per Mender**

A Mender-level timestamp (epoch ms, `null` if never), distinct from the
existing per-region `regionStats[id].lastActiveAt` used by the decay
mechanic — this one answers "when did this Mender last do *anything*,"
not "when did they last touch *this region*."

- Stamped on every `persistCurrentMenderSave()`, and immediately on
  login (not just deferred to the next save), so it's accurate even for
  a Mender who opens the app and changes nothing.
- Stored in the save payload (`currentSavePayload()` /
  `defaultSavePayload()` / `loadStateFromSave()`), so it syncs and
  persists exactly like every other save field already does.
- New shared helpers: `getMenderLastActiveAt(id)`, `formatLastActive(ts)`
  ("3 days ago" style, coarse by design — not a precise audit log),
  `sortMenderIds(ids, mode)`, `buildMenderSortControl()`.
- Surfaced in all three requested spots — admin Menders pane
  (selected-pupil line), Bulk Actions dropdown (appended to each
  option's label), and Fleet View (new line per card) — each with a
  shared "Sort by: Name / Most recent / Least recent" control so a
  teacher can find who's fallen behind at a glance. Never-active Menders
  sort to the appropriate end regardless of direction.
- **Decay-ready by design**: same epoch-ms shape and null-when-never
  convention as `regionStats[id].lastActiveAt`, so if/when a
  whole-account decay reference point is wanted, this field can be
  consumed directly — no rework, no format translation.

Verified with a standalone Node test of `formatLastActive` (edge cases:
null, "just now", minutes/hours/days/months/years) and `sortMenderIds`
(both directions, plus never-active Menders sorting correctly) before
shipping.

---

## v2.1

**Bug fix: repeat-submission exploit.** On 7 of 9 regions (all except
plain MCQ), clicking Submit repeatedly on the same rendered question —
with zero navigation in between — re-ran `grantReward()` every time,
letting a student farm resources, rush stability to 100%, and re-trigger
streak bonus thresholds (3/5/10/15) for free. `showFeedback()` only ever
touched a separate `feedbackHolder` element, never the Submit button
itself, so nothing stopped repeat clicks.

Fixed by adding a disable-on-first-click guard to all 6 affected
`onclick` handlers (sealed_scrolls, rope_bridge/reading_room,
notice_board, restoration_bench, alchemists_forge, oracles_chamber):

```js
submitBtn.onclick = ()=>{
  if (submitBtn.disabled) return;
  submitBtn.disabled = true;
  // ...rest of the original handler, unchanged
};
```

oracles_chamber needed a slightly different fix, since its handler is
async: the original code re-enabled the button in a `finally` block once
AI grading finished, reopening the same hole after a short delay. Fixed
by leaving it disabled permanently after submit and only resetting the
button's label text in `finally`, not its disabled state.

Plain MCQ (checkpoint_gates, bazaar) was already safe — its per-option
buttons are disabled synchronously, inline, before `grantReward()` runs —
and was left untouched, used as a regression control.

Verified three ways: `node --check` on the full script; a standalone
functional test simulating 5 rapid clicks against the guard pattern
(confirmed exactly 1 `grantReward()` call, down from 5); and re-checking
the guard count and syntax straight from the packaged zip, not just the
working copy.

**Added: ink-explainers.js, integrated (not just included)**

`public/index.html` now inlines the full `ink-explainers.js` module
(attaches as `window.InkExplainers`) and wires it into six of the eight
question mechanics as an *upgrade path* in front of the original
`buildExplainer()` system — never a replacement:

- checkpoint_gates (mcq)
- bazaar (mcq)
- sealed_scrolls (cloze_bank)
- rope_bridge (cloze_free)
- reading_room (cloze_free)
- notice_board (visual_mcq)

For each of these, a new `modernExplainer()` helper builds a small
"shim" question object out of this file's existing per-region side
tables (`CG_EXPLAIN`, `BZ_CLUE`, `SS_CLUE`, `NB_EVIDENCE`, `RB_EXPLAIN`,
`RR_EXPLAIN`) mapped onto the module's schema field names
(`errorCategory`, `focusSpan`, `tenseName`, `clueSpan`, `evidenceSpan`,
`chunkMap`, `rubric`, `sampleAnswer`) and calls
`InkExplainers.buildExplainerFor()`. **No content re-authoring was
needed** — existing question data works with the module as-is.

If the module returns nothing (missing mapping, module not loaded,
runtime error) the original `buildExplainer(spec)` call renders exactly
as it did in v2.0 — verified with a standalone Node smoke test against
representative questions from every wired mechanic before shipping.

**Two mechanics intentionally stay on the legacy path only:**

- **restoration_bench** (editing) — uses a "tag" explainer (highlighted
  error word + correction + category badge) that the module doesn't
  define a component for.
- **alchemists_forge** (synthesis) — uses a "transform" explainer
  (highlighted span within the transformed answer) that the module
  doesn't define a component for either.

Both could be added to the module later (as new component types) if
you want full coverage — this integration didn't stretch the module's
existing 5 types to force a fit, since that would have meant guessing
at content decisions that are really yours to make.

**oracles_chamber (short_answer) also intentionally stays on the legacy
path.** The module's `EVIDENCE_SPOTLIGHT` type would work here, but its
rule text has no hook to say whether AI or keyword marking produced the
result — a distinction added in the AI-marking work earlier in v2.1 and
worth keeping visible to the player. The module's default rubric wording
is word-for-word identical to this file's own `RUBRIC_CHECKLIST`, so
nothing is lost by staying on the legacy renderer here.

**Not called: `InkExplainers.injectStyles()`.** This page already ships
matching CSS for every class the module renders
(`.explainer`, `.evidence-box`, `.timeline-row`, `.chunk-row`,
`.rubric-list`, `mark.hl`, etc.) — themed to Inkbound's noir palette.
The module's bundled CSS uses different (generic cream/light) colors for
the same class names; since a later `<style>` tag wins on equal
specificity, injecting it would have visually overridden the existing
theme. Skipped entirely; zero behavior change either way.

**Bonus, available but not wired into any UI:** `window.InkExplainers`
also exposes `coverageReport(QUESTION_BANK)` (authoring-progress by
region) and `lintExplainerFields()` (schema validation) if you want to
use them from the browser console or build them into the admin panel
later.

---

## v2.0 → v2.1, everything else

Carried over unchanged from the two prior deployment-prep passes:
Firebase + Cloudflare KV dual sync (`fbPushDoc`/`fbListenDoc` fan-out),
optional AI marking for the Oracle's Chamber (Gemini → Groq → xAI →
Cloudflare Workers AI → local keyword fallback), and the sync/AI status
icon pair top-right. See `README.md` and `worker/README.md` for setup.
