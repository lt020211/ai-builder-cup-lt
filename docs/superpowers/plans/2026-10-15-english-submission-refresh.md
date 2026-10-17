# English Submission Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an English-first competition submission with natural operations copy, explicit team leadership, accurate REA boundaries, refreshed media, and a public Google Drive demo-video link.

**Architecture:** Preserve all machine interfaces and diagnostic behavior while replacing presentation strings, prompts, and reviewer-facing comments. Add stable DOM state markers so browser checks and recording scripts no longer depend on visible language. Regenerate media only after the application and tests are stable, then publish and add the verified Drive URL.

**Tech Stack:** Static HTML/CSS, browser ES modules, Node.js verification and browser scripts, Firebase Hosting and Firestore, Gemini through Firebase AI Logic, slidep/Python deck pipeline, existing video pipeline, Google Drive.

**Spec:** `docs/superpowers/specs/2026-10-15-english-submission-refresh-design.md`

## Global Constraints

- Preserve function names, action IDs, classification IDs, case IDs, Firestore fields, DOM IDs, `data-tab` values, and citation IDs.
- Preserve the rule baseline at 11/14, the 10-tool inventory, the 6/10 mode split, and the 6/5/3 action-risk distribution.
- Keep REA out of runtime dependencies and state plainly that it is not included in this build.
- Use concise operations language. Remove star markers, excessive emoji, rhetorical self-defense, repeated claims of credibility, and personification.
- Keep Chinese only in explicitly localized documents, Chinese input-match data, and bilingual subtitle content.
- Use `lt020211 - Team Lead and Engineer`; do not claim that README text proves team eligibility.
- Keep the repository MP4 and add the final Google Drive viewer URL after the regenerated file is uploaded and shared.
- Bump the browser result cache from `triage:cache:v2` to `triage:cache:v3`.
- Work in the approved current checkout. Do not auto-commit because touched files already contain user-owned uncommitted changes; record diffs and tests in the SDD ledger instead.
- Do not push, deploy, clear Firestore data, or make a Drive file public without the required final confirmation.

---

### Task 1: Submission And Evidence Verification Contracts

**Files:**
- Create: `scripts/verify_submission.mjs`
- Modify: `scripts/verify_triage.mjs`
- Modify: `firebase/public/js/tools.js`
- Test: `scripts/verify_submission.mjs`
- Test: `scripts/verify_triage.mjs`

**Interfaces:**
- Consumes: current README files, `firebase/public/index.html`, `firebase/public/js/tools.js`, and the repository MP4.
- Produces: a pre-publish submission check, a strict publish check, and explicit evidence-tier invariants used by later tasks.

- [ ] **Step 1: Write the failing submission verifier**

Create a Node script that asserts:

```js
assert.match(readme, /^# Training Failure Triage/m);
assert.match(readme, /lt020211\s+-\s+Team Lead and Engineer/);
assert.match(html, /<html\s+lang="en">/);
assert.ok(existsSync('docs/Training-Failure-Triage-demo.mp4'));
if (!process.argv.includes('--prepublish')) {
  assert.match(readme, /https:\/\/drive\.google\.com\//);
}
```

The script must also reject `example.com`, `PUBLIC_URL`, `TODO`, and empty Markdown links. It prints one check per line and exits nonzero on failure.

- [ ] **Step 2: Verify the submission test fails for the expected current-state reasons**

Run: `node scripts/verify_submission.mjs --prepublish`

Expected: FAIL because the default README and HTML language are not yet English and the team-lead line is absent.

- [ ] **Step 3: Write failing evidence-tier invariants**

Extend `verify_triage.mjs` to assert:

```js
assert.deepEqual(Object.keys(EVIDENCE_TIERS), ['snapshot', 'live', 'artifact']);
assert.deepEqual(Object.values(EVIDENCE_TIERS).map((x) => x.order), [1, 2, 3]);
assert.equal(EVIDENCE_TIERS.snapshot.implemented, true);
assert.equal(EVIDENCE_TIERS.live.implemented, true);
assert.equal(EVIDENCE_TIERS.artifact.implemented, false);
assert.equal(evidenceTier('snapshot').evidence_tier, 'snapshot');
assert.equal(evidenceTier('live').evidence_tier, 'live');
assert.throws(() => evidenceTier('artifact'), /no producer|没有生产者/i);
assert.throws(() => evidenceTier('unknown'), /unknown|未知/i);
```

Add tool-result assertions showing that successful `inspect_node` snapshot/live results and `scan_cluster` results carry the expected tier, while no-evidence error results carry no tier.

- [ ] **Step 4: Verify the new evidence assertions fail before compatibility changes**

Run: `node scripts/verify_triage.mjs`

Expected: any mismatch in English error contracts or missing tier propagation fails with a focused assertion message.

- [ ] **Step 5: Make the evidence contract language-neutral and pass**

Use error codes or invariant properties for assertions instead of requiring Chinese prose. Keep the current runtime behavior and add no REA dependency.

- [ ] **Step 6: Run task verification**

Run:

```bash
node scripts/verify_triage.mjs
node scripts/verify_pipeline.mjs
```

Expected: F8 remains 11/14 and pipeline remains 81/81.

---

### Task 2: Stable Browser State Contract

**Files:**
- Modify: `firebase/public/js/app.js`
- Modify: `firebase/public/index.html`
- Modify: `scripts/browser_check.mjs`
- Modify: `scripts/record_demo.mjs`
- Test: `scripts/browser_check.mjs`
- Test: `scripts/record_demo.mjs`

**Interfaces:**
- Consumes: existing buttons and DOM IDs.
- Produces: `data-state="idle|running|complete|failed"` on the case and patrol roots, plus stable reset status markers used by browser and recording automation.

- [ ] **Step 1: Change acceptance checks to require stable state attributes**

Before adding attributes in production code, make browser and recording checks wait for selectors such as:

```js
await page.waitForSelector('#tab-case[data-state="complete"]');
await page.waitForSelector('#tab-patrol[data-state="complete"]');
await page.waitForSelector('#cluster-status[data-state="reset"]');
```

Replace waits that depend on `完成`, `失败`, or `已重置`. Keep assertions on numeric results and stable IDs.

- [ ] **Step 2: Verify the state-contract checks fail**

Run a static contract check over `app.js`, `index.html`, `browser_check.mjs`, and `record_demo.mjs` that proves the scripts expect attributes not yet produced.

- [ ] **Step 3: Add minimal state transitions**

Set `idle` on initial render, `running` before an async operation, `complete` after successful rendering, and `failed` in the corresponding catch path. Set the cluster reset marker only after Firestore reset and reread complete.

- [ ] **Step 4: Verify the static and offline contracts**

Run:

```bash
node --check firebase/public/js/app.js
node --check scripts/browser_check.mjs
node --check scripts/record_demo.mjs
node scripts/verify_pipeline.mjs
```

Expected: syntax checks pass and pipeline remains 81/81.

---

### Task 3: English Application Shell And Orchestration

**Files:**
- Modify: `firebase/public/index.html`
- Modify: `firebase/public/js/app.js`
- Modify: `firebase/public/js/prompt.js`
- Modify: `firebase/public/js/ai.js`
- Modify: `firebase/public/styles.css`
- Test: `scripts/verify_submission.mjs`
- Test: `scripts/verify_pipeline.mjs`

**Interfaces:**
- Consumes: stable state attributes from Task 2 and existing domain objects.
- Produces: an English page shell, English dynamic UI, English model instructions, English offline orchestration messages, and cache key `triage:cache:v3`.

- [ ] **Step 1: Add failing English-shell checks**

Extend the pre-publish verifier to require:

```js
assert.match(html, /Training Failure Triage/);
assert.doesNotMatch(html, /[\u3400-\u9fff]/);
assert.match(appSource, /triage:cache:v3/);
assert.match(promptSource, /Respond in English/);
```

Permit Chinese only in an explicit internal match-data allowlist, not user-visible HTML or orchestration strings.

- [ ] **Step 2: Verify the checks fail on the Chinese shell**

Run: `node scripts/verify_submission.mjs --prepublish`

Expected: FAIL on HTML language, Chinese visible copy, cache version, and English response instruction.

- [ ] **Step 3: Translate the shell and orchestration copy**

Translate all visible content in the four tabs, dynamic status/empty/error text, benchmark summaries, approval controls, and execution-package labels. Use `Tool trace`, `On-call patrol`, `Rule baseline`, and `Action library and approvals` consistently.

Translate module and safety-invariant comments in the four touched source files. Keep technical names and selectors unchanged. Replace rhetorical comments with short engineering explanations.

- [ ] **Step 4: Update prompts and cache version**

All case and patrol prompts must say `Respond in English`. Preserve tool requirements, risk restrictions, citation format, and `MAX_TOOL_TURNS` behavior. Change only the cache namespace to `triage:cache:v3`.

- [ ] **Step 5: Run task verification**

Run:

```bash
node scripts/verify_submission.mjs --prepublish
node scripts/verify_pipeline.mjs
node --check firebase/public/js/app.js
node --check firebase/public/js/prompt.js
node --check firebase/public/js/ai.js
```

Expected: pre-publish checks pass for the shell and pipeline remains 81/81.

---

### Task 4: English Domain Content And Core Comments

**Files:**
- Modify: `firebase/public/js/actions.js`
- Modify: `firebase/public/js/kb.js`
- Modify: `firebase/public/js/triage.js`
- Modify: `firebase/public/js/tools.js`
- Modify: `firebase/public/js/cluster.js`
- Modify: `firebase/public/data/cases.json`
- Modify: `firebase/public/data/cluster_seed.json`
- Modify: `scripts/verify_triage.mjs`
- Modify: `scripts/verify_pipeline.mjs`
- Test: `scripts/verify_triage.mjs`
- Test: `scripts/verify_pipeline.mjs`

**Interfaces:**
- Consumes: stable IDs and English prompt/output contract.
- Produces: English case, knowledge, action, tool, cluster, ticket, notification, and offline-triage presentation content while preserving machine values.

- [ ] **Step 1: Add failing domain-language checks**

Scan human-facing values and core comments for Han characters while excluding explicit Chinese log-recognition patterns. Check that machine identifiers and counts remain unchanged.

- [ ] **Step 2: Verify the domain-language check fails**

Run: `node scripts/verify_submission.mjs --prepublish`

Expected: FAIL with the first file and line containing non-allowlisted Chinese presentation content.

- [ ] **Step 3: Translate domain content**

Translate labels, descriptions, causes, recommendations, impact text, commands' explanatory notes, expected results, rollback guidance, telemetry notes, error messages, ticket text, and notification text. Do not translate shell commands, regex tokens, IDs, enum values, version strings, or cited URLs.

- [ ] **Step 4: Translate core implementation comments**

Replace Chinese comments with concise English comments that explain invariants: evidence-only tools, parameter allowlists, risk ownership, approval gates, read-back verification, offline fallback, and model-resume behavior. State REA's absence once near `EVIDENCE_TIERS`; avoid repeating roadmap copy throughout the source.

- [ ] **Step 5: Update tests without weakening behavior**

Replace Chinese prose assertions with stable IDs, error codes, structured fields, or exact English messages where message wording is itself the contract. Keep all numeric and safety assertions.

- [ ] **Step 6: Run task verification**

Run:

```bash
node scripts/verify_submission.mjs --prepublish
node scripts/verify_triage.mjs
node scripts/verify_pipeline.mjs
```

Expected: no non-allowlisted Chinese presentation strings; F8 remains 11/14; pipeline remains 81/81.

---

### Task 5: English Default Documentation And Accurate Submission Claims

**Files:**
- Create: `README.zh-CN.md`
- Modify: `README.md`
- Remove or redirect: `README.en.md`
- Modify: `docs/architecture.en.md`
- Modify: `docs/demo-script.en.md`
- Modify: `docs/architecture.md` only to repair language links
- Modify: `docs/demo-script.md` only to repair language links
- Modify: `scripts/verify_submission.mjs`
- Test: `scripts/verify_submission.mjs`

**Interfaces:**
- Consumes: English application terminology from Tasks 3 and 4.
- Produces: concise English default documentation, a clearly named Chinese supplement, team-lead attribution, an accurate REA statement, and a deliberate pre-publish video state.

- [ ] **Step 1: Extend documentation checks and verify they fail**

Require the default README to include the live demo, `lt020211 - Team Lead and Engineer`, `REA is not included in this build`, the repository MP4, a pre-publish Drive status, and correct links to `README.zh-CN.md`.

Run: `node scripts/verify_submission.mjs --prepublish`

Expected: FAIL until documentation is reorganized.

- [ ] **Step 2: Make English the default**

Build the new `README.md` from the useful parts of the existing English README. Keep problem, demo, team, workflow, architecture, benchmark, safety boundaries, verification, deployment, and limitations. Move the current Chinese default to `README.zh-CN.md` and update language links.

- [ ] **Step 3: Remove generated-sounding prose**

Remove repeated phrases about proving honesty, not faking execution, judge reactions, and internal production history. Use factual descriptions and keep measured numbers with their measurement context.

- [ ] **Step 4: Correct REA and video wording**

Use this boundary verbatim where a concise statement is needed:

```text
REA is not included in this build. The browser application produces snapshot and live evidence only. A future CLI or server deployment could evaluate rea-agents for local artifact inspection.
```

Before publication, label the Drive link as upload pending while keeping the repository MP4 available. Do not mark the public-link requirement complete yet.

- [ ] **Step 5: Run documentation verification**

Run: `node scripts/verify_submission.mjs --prepublish`

Expected: PASS with a deliberate pending-publication status and no fake URL.

---

### Task 6: Automation And Reviewer-Facing Source Cleanup

**Files:**
- Modify: `scripts/browser_check.mjs`
- Modify: `scripts/record_demo.mjs`
- Modify: `scripts/capture_shots.mjs`
- Modify: `scripts/demo_voice.py`
- Modify: `scripts/demo_caption.py`
- Modify: `scripts/fb_deploy.py`
- Modify: `scripts/fb_firestore_setup.py`
- Modify: `scripts/probes/*.py`
- Modify: `deck/make_crops.py`
- Modify: `deck/make_pdf.py`
- Modify: `deck/probe_bands.py`
- Modify: `deck/probe_layout.py`
- Test: syntax checks and recording dry run

**Interfaces:**
- Consumes: English UI text and stable state markers.
- Produces: English comments and CLI output for public source files without changing automation behavior.

- [ ] **Step 1: Add a source-comment language check and verify it fails**

Extend `verify_submission.mjs --prepublish` to scan executable `.js`, `.mjs`, and `.py` files for Chinese comments and non-localized CLI output. Exclude bilingual subtitle payloads and explicit Chinese input-match fixtures.

- [ ] **Step 2: Translate comments and CLI output**

Translate public implementation comments and operator messages. Remove star markers, rhetorical warnings, and retrospective storytelling. Preserve command-line options, output files, selectors, timings, and state transitions.

- [ ] **Step 3: Run syntax and dry checks**

Run:

```bash
node --check scripts/browser_check.mjs
node --check scripts/record_demo.mjs
node --check scripts/capture_shots.mjs
python3 -m py_compile scripts/*.py scripts/probes/*.py deck/*.py
node scripts/record_demo.mjs --dry --no-reset
node scripts/verify_submission.mjs --prepublish
```

Expected: syntax checks pass, dry recording does not write Firestore, and source-language checks pass.

---

### Task 7: Deck And Screenshot Refresh

**Files:**
- Modify: `deck/slides/*.slide`
- Modify: `deck/DESIGN.md`
- Modify: `deck/STORY.md`
- Modify: `deck/Training-Failure-Triage.pptx`
- Modify: `docs/Training-Failure-Triage-deck.pdf`
- Modify: `deck/assets/*.png`
- Modify: `shots/clean/*`
- Modify: `shots/shift/*`
- Test: deck render, PDF compile/render, and visual inspection

**Interfaces:**
- Consumes: final English live/local UI and accurate REA boundary.
- Produces: a 15-page English deck, editable PPTX, refreshed evidence screenshots, and PDF.

- [ ] **Step 1: Update slide copy before recapturing**

Remove AI-style punctuation and slogans from slide titles and body copy. Keep measured claims and existing visual hierarchy. On slide 14, state that REA is not part of the submitted build and is only a future option for a non-browser deployment.

- [ ] **Step 2: Capture English UI evidence**

Run the existing capture script against the verified English application. Preserve the `clean` and `shift` state distinction and regenerate geometry files before crops.

- [ ] **Step 3: Regenerate crops and deck outputs**

Run the repository's existing slidep/crop/PDF pipeline. Keep 15 pages, 1920x1080 render images, and the editable PPTX.

- [ ] **Step 4: Render and inspect every slide**

Verify no clipping, overlap, stale Chinese UI screenshots, incorrect metrics, or unreadable body text. Confirm the PDF reports 15 pages.

---

### Task 8: End-To-End Application And Video Regeneration

**Files:**
- Modify: `docs/Training-Failure-Triage-demo.mp4`
- Modify: `shots-demo/beats.json`
- Modify: `shots-demo/timeline.json`
- Modify: `shots-demo/voice.m4a`
- Modify: bilingual narration/subtitle inputs used by the existing pipeline
- Test: browser acceptance, recording gates, media metadata

**Interfaces:**
- Consumes: final English application, stable browser state, and refreshed storyboard.
- Produces: a final MP4 under 180 seconds at 1600x900 with English narration and bilingual hard subtitles.

- [ ] **Step 1: Run local browser acceptance**

Serve `firebase/public/`, run `browser_check.mjs`, and confirm all four workspaces, live Gemini path, Firestore read/write, approval boundaries, and benchmark behavior.

- [ ] **Step 2: Record the verified workflow**

Run the existing recorder against the final application. The recorder must read tool counts from the UI, enforce the active-panel precondition, and finish without frozen-frame or unresolved-placeholder violations.

- [ ] **Step 3: Regenerate narration and captions**

Use the English voice-over and bilingual hard subtitles. Preserve rate clamps and shot timing derived from the recorded timeline.

- [ ] **Step 4: Verify media metadata and content**

Confirm duration below 180 seconds, 1600x900 dimensions, 15 fps, audible narration, visible subtitles, and no stale Chinese-only UI frames.

---

### Task 9: Publish, Upload, Link, And Final Verification

**Files:**
- Modify: `README.md` with the verified Drive viewer URL
- Modify: `scripts/verify_submission.mjs` only if the final URL shape exposes a Drive variant already covered by policy
- Test: all offline, browser, media, live-site, and submission checks

**Interfaces:**
- Consumes: final site, deck, and MP4.
- Produces: deployed English demo, public Google Drive viewer link, strict submission verification, and a complete handoff report.

- [ ] **Step 1: Run the full pre-publication suite**

Run:

```bash
node scripts/verify_submission.mjs --prepublish
node scripts/verify_triage.mjs
node scripts/verify_pipeline.mjs
node scripts/browser_check.mjs http://127.0.0.1:8899/
```

Expected: all checks pass; F8 is 11/14; pipeline is 81/81.

- [ ] **Step 2: Stop for external-side-effect confirmation**

Present the exact Firebase deployment target, Firestore reset scope, Google Drive file name, and requested `Anyone with the link` permission. Do not publish, clear, upload, or change sharing before the confirmation required for each action.

- [ ] **Step 3: Deploy and verify the live site**

Use `python3 scripts/fb_deploy.py firebase/public`, reset only the four documented demo collections if approved, and run the browser acceptance suite against the live URL.

- [ ] **Step 4: Upload and share the final video**

Upload `docs/Training-Failure-Triage-demo.mp4` to Google Drive. After the sharing confirmation, set viewer access to `Anyone with the link`, copy the verified viewer URL, and confirm it opens without authentication.

- [ ] **Step 5: Add the URL and run strict submission verification**

Replace the deliberate pending-publication line with the verified Drive URL. Run:

```bash
node scripts/verify_submission.mjs
node scripts/verify_triage.mjs
node scripts/verify_pipeline.mjs
```

Expected: strict submission checks pass, F8 remains 11/14, and pipeline remains 81/81.

- [ ] **Step 6: Perform final review**

Review all user-owned and new changes without reverting unrelated work. Report any residual compliance risk, including the fact that README attribution does not prove registration eligibility.
