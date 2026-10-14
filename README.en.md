# Training Failure Triage

> Google Cloud AI Builder Cup 2026 (JAPAC) — competition entry
> Entrant: lt020211 ｜ Project: AI Builder Cup-lt

**Language:** 🇬🇧 English ｜ [🇨🇳 中文](README.md)

## 🟢 Live demo (deployed, one click)

**<https://gpu-waste-auditor-2026.web.app>** ｜ mirror: <https://gpu-waste-auditor-2026.firebaseapp.com>

> The site name is a leftover from the previous topic (`gpu-waste-auditor-2026`). **The domain no longer
> describes the topic.** Recreating the site would mean redoing the whole Hosting setup for no real gain,
> so the original name was kept.

The page has four tabs: **Single case triage** / **On-call Agent** / **Benchmark** / **Action library & approval**.
Nothing needs configuring to start: the cluster state and the case library are built in, and the free tier
is enough for a full demo (one patrol takes about 12–16 model requests, derived from tool rounds — see
"The free tier is the hardest constraint" below).

## 🎬 Demo video and solution deck

| Deliverable | File | Spec |
|---|---|---|
| Demo video | [`docs/Training-Failure-Triage-demo.mp4`](docs/Training-Failure-Triage-demo.mp4) | **2:45** (limit: 3 min), 1600×900, 15 fps, **English voice-over**, bilingual hard subtitles, 20 shots |
| Solution deck | [`docs/Training-Failure-Triage-deck.pdf`](docs/Training-Failure-Triage-deck.pdf) | 14 pages, three chapters |

**Neither was edited by hand.** The video comes from `scripts/record_demo.mjs`, which **actually walks the live
site** shot by shot per [docs/demo-script.en.md](docs/demo-script.en.md) and records the frames; the English
voice-over is synthesised and fitted to each shot's real time window by `scripts/demo_voice.py`; the subtitles,
progress bar and encoding are burned in by `scripts/demo_caption.py`. Every reading in the deck is likewise
screenshotted from a real running page.

```
node scripts/record_demo.mjs                        # record: walk the live site → shots-demo/
python3 scripts/demo_voice.py                       # narrate: per-shot English voice → shots-demo/voice.m4a
python3 scripts/demo_caption.py --dir shots-demo \
        --out docs/Training-Failure-Triage-demo.mp4 \
        --voice shots-demo/voice.m4a                # compose: captions + progress bar + voice + encode
```

Splitting it into three makes it **re-runnable**: changing the words only means re-composing, never re-recording
(and re-recording costs model quota again). Each subtitle switches at the real start/end time recorded for that
shot; nothing is cut or joined, so picture and words line up by construction.

The narration works the same way: **synthesise first, measure the real duration, and only then pick a speaking
rate.** A line that will not fit its shot means the line is too long, not that it should be read faster — the
rate is clamped to −15% ~ +30% (`RATE_MIN` / `RATE_MAX` in `scripts/demo_voice.py`) and any shot that hits the
clamp is listed in the log. A few seconds of silence over a wide shot, while the viewer reads the screen, is
the better trade.

> ★ The recorder doubles as a **gatekeeper for the evidence**: it blocks four classes of defect from shipping —
> a caption still holding an unfilled call-count placeholder, long frozen stretches (a held frame reads as
> "it is thinking"), a total runtime over 180 seconds, and **the wrong panel in frame before recording**.
> That last one comes from a real incident: one whole take was recorded on the "single case triage" tab and
> the log showed nothing wrong. It is a hard assertion now, not a box on a checklist. See the "produced by
> scripts" section of [docs/demo-script.en.md](docs/demo-script.en.md).

**The video volunteers three boundaries** (without them, it would look more credible than it is):

1. The demo cluster is a **constructed simulated environment** — no real cluster information, no connection to
   any production cluster;
2. The patrol is **started by a human click** — a static site has no resident process, and a real deployment
   should be triggered by Cloud Scheduler;
3. Notifications land in the `notifications` queue and are **not pushed to IM**.

## One-line pitch

**We turn a training-failure scene into a root-cause judgement with a complete evidence chain — and answer
the question that actually matters: is this the code's fault, or is it time to replace the card?**

Frontline ops faces a pair of **opposite-direction** mistakes, and public cluster-ops literature keeps
making the same point:

| Mistake | How it looks | What it costs |
|---|---|---|
| **Treating an application bug as a hardware fault** | See Xid 13 / 31 / 43 and file an RMA | A perfectly good card is taken offline, an RMA is filed, capacity is wasted |
| **Treating hardware degradation as a one-off** | See Xid 94 and say "just restart it" | Degradation keeps accumulating until Xid 95 shows up and the blast radius has already grown |

Both mistakes **can be triggered by the same error code**. So the discriminating evidence cannot be the code
itself — it has to be **trend** (30-day frequency, whether correctable ECC is rising in step),
**causal chain** (is Xid 45 a secondary event or the root cause), and **kernel / process state**. Those three
are exactly what a model can do and a lookup table cannot.

## How it maps to the theme

| Item | Detail |
|---|---|
| Theme / track | Sustainability & Social Impact |
| Target users | Frontline ops and platform teams running multi-cloud GPU training clusters |
| Core pain point | Monitoring tells you *which Xid fired*; it never tells you *whether to replace the card*. And the error is bidirectional: a good card gets retired, or a bad one gets waved through |
| Our approach | Gemini autonomously calls 10 tools to gather evidence (Xid knowledge base, node telemetry, memory accounting, version-stack validation) and produces two directly actionable outputs: a **six-way classification** and a **should-file-RMA boolean**. In on-call mode it also stops the bleeding itself, drafts the ticket, and notifies the human |
| Why AI is required | "One-off vs degrading" and "secondary vs root cause" require cross-field causal inference. A rule engine can produce a vote count but not a causal chain — and we prove this with a reproducible benchmark (11/14) rather than claiming it |

### Three differentiating design choices

**1. The AI is a tool caller, not a text generator.**
The model must call `lookup_xid` for the knowledge base and `inspect_node` for the trend before it is allowed
to conclude anything. Every number comes from deterministic code, so the model cannot invent one — and the UI
shows **every call and its arguments verbatim**, with each conclusion carrying a citation id (`T2`) that points
back to the call that produced it.

**2. Risk levels do not come from the model.**
The `risk` field of all 14 remediation actions is hard-coded in the action library. The model can only
**select** an action via `action_id`; it has **no way whatsoever** to declare or modify the level — it does
not even have a parameter that could express "call this one low risk". So the model cannot talk the system
into downgrading a high-risk action (reinstalling a driver, filing an RMA) to bypass approval. This is the
same discipline as "numbers must come from tools", applied at a different layer.

**3. Execution is real, and it is verified afterwards.**
On-call mode is wired to a **simulated cluster with real state** (Cloud Firestore). The Agent's
"stop the bleeding" step is not a UI animation: it genuinely rewrites node state, then **reads it back itself**
to confirm the change took effect, and every action is written to an operation log. If an action ran but the
state did not change, the log says "verification failed" rather than claiming success. You can refresh the
`cluster` collection in the Firebase console and watch the data change.

## What one patrol actually does

The numbers below are **from a live run** — measured, not aspirational:

| Item | Measured |
|---|---|
| Tool calls | **16** (one `scan_cluster` → per-node `inspect_node` → `lookup_xid` → `execute_action` → `draft_ticket` → `notify_operator`) |
| Actions executed | **2, both "verification passed"** (cordon on two nodes — no new jobs accepted) |
| Tickets awaiting human approval | **1** (status `draft`, labelled "draft · awaiting human submission") |
| Notification queue | **1** (status `queued`) |
| Wall-clock | **41.2 s** |

> ★ **Every patrol is different.** The cluster is reset before each one, but the route through it is the
> model's own, so the call count and the notification count move. The demo video shipped in this repository
> is **a different patrol**: **17** tool calls, 2 operation-log entries, 3 queued notifications.
> "17 tool calls" in the video's subtitles was not written in advance — the recorder reads the real number
> off the screen after the patrol finishes and fills it back in (the `{calls}` placeholder in
> `scripts/record_demo.mjs`; see `docs/demo-script.en.md`).

That run contains the most convincing contrast we have: **two nodes both reported Xid 94, with opposite conclusions.**

- `lyg2103`: **1** occurrence in 30 days, correctable ECC flat → `hardware_watch`, **do not file an RMA**
- `lyg2112`: **53** occurrences in 30 days, correctable ECC at **118** and still rising → hardware degradation, **file an RMA**

The distinguishing evidence is **not the error code. It is the 30-day trend behind it**.

## Why a model is required: a reproducible comparison

"This is something rules do badly" is a **falsifiable** claim, so we actually ran it to try to falsify it.

`scripts/verify_triage.mjs` runs the entire 14-case library through the **pure rule path** (take the
highest-voted classification from pre-analysis; if it is `hardware`, recommend an RMA — i.e. the most common
real-world approach: look up the Xid code in a table):

```
Rule baseline accuracy (classification AND RMA decision both correct): 11 / 14  (78.6%)
  Classification only: 11 / 14   RMA decision only: 12 / 14
```

The three it gets wrong each map onto one diagnostic principle:

| Case | Expected | Rule says | What the rule cannot read |
|---|---|---|---|
| `case-xid48-dbe` | hardware + RMA | application | Xid 45 is "a consequence of a preceding error"; treating it as the root cause sends you the wrong way |
| `case-xid94-rising` | hardware + RMA | hardware_watch | Same code, same GPU model as `case-xid94-single` — the discriminator is the trend, not the code |
| `case-gpu-hang-deadlock` | application | network | Both this and `case-gpu-hang-xid62` are "training hang"; the discriminator is whether the kernel log is clean and whether the process is in D state |

This number is **verifiable in the browser by anyone** (Benchmark tab → run rule baseline; local, instant,
no quota consumed) — the page runs the same code. **We do not report any score we cannot reproduce.**
The AI side of that table is not hand-filled: it is tallied automatically once all 14 cases have run, and stays
blank until then.

## The four tabs

| Tab | The question it answers |
|---|---|
| **Single case triage** | Paste a failure scene → six-way classification + RMA decision + evidence chain + action list (ordered low-risk first) + downloadable execution package |
| **On-call Agent** | No log pasted. Click once and it scans the cluster itself → gathers evidence → stops the bleeding → drafts the ticket → notifies the human. Includes cluster state, tool-call trace, operation log (with verification results), pending human approval, notification queue |
| **Benchmark** | The same case library through two paths, compared on two fields that can be falsified on the spot: **classification** and **RMA decision** |
| **Action library & approval** | Each of the 14 actions' blast radius, approval requirement, commands, expected output and rollback — plus the actions the system **explicitly discourages** |

## Quick start (local)

This is a **purely static site**: no backend service, no build step. Serve `firebase/public/` with any static
server.

```bash
# Serve locally (Python's built-in server; no dependencies to install)
python3 -m http.server 8899 --directory firebase/public
# Open http://127.0.0.1:8899/
```

Run the three verification scripts (Node ≥ 18; the two `verify_*` scripts are fully offline and consume no
model quota):

```bash
node scripts/verify_triage.mjs      # invariant checks + F8 benchmark (rule baseline 11/14)
node scripts/verify_pipeline.mjs    # end-to-end contract test: stubbed fetch, full model → tools → result chain
node scripts/browser_check.mjs http://127.0.0.1:8899/   # real-Chrome end-to-end acceptance (calls the model for real)
```

| Script | Current status | What it does *not* need |
|---|---|---|
| `verify_triage.mjs` | **all pass**; F8 baseline **11 / 14** | no network, no Firestore, no quota |
| `verify_pipeline.mjs` | **81 / 81** pass | no network, no Firestore, no quota |
| `browser_check.mjs` | **31 / 31** pass (identical assertions locally and against the live site) | needs Chrome; does call the model and does read/write Firestore for real |

> `browser_check.mjs` uses a throwaway temporary profile by default. Passing `TRIAGE_PROFILE=<dir>` reuses one
> profile — the benefit is that the AI result cache the page keeps in `localStorage` survives across runs, so
> **repeat verification does not burn quota over and over**.

## Deployment

### Publishing the static site (this is what the live demo uses)

```bash
# Plain REST — no firebase CLI, no interactive OAuth
python3 scripts/fb_deploy.py firebase/public
```

> Why not `firebase deploy`: the CLI is not installed on this machine and it requires an interactive OAuth
> flow; gcloud is already logged in, so calling the Hosting REST API directly is simpler. The script's inline
> comments record three pitfalls that were hit (hashing the gzipped bytes, not sending `Content-Encoding`,
> pinning `mtime=0` so the compressed output is reproducible).

### Configuring the simulated cluster backend (Firestore)

```bash
python3 scripts/fb_firestore_setup.py check    # read-only: does the database exist, what are the current rules
python3 scripts/fb_firestore_setup.py rules    # write the security rules
python3 scripts/fb_firestore_setup.py seed     # reset the seed data (6 nodes + telemetry history)
python3 scripts/fb_firestore_setup.py verify   # one read/write to confirm anonymous browser access really works
```

## How it works

```
Case library (14 cases, incl. three contrast pairs)     Simulated cluster (Firestore, 6 nodes)
        │                                                        │
        ▼                                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  Knowledge base layer  kb.js                                               │
│  24 Xid entries (each with an official doc URL) ｜ 27 failure signatures ｜  │
│  6 diagnostic principles ｜ version matrix ｜ memory specs                  │
└────────────────────────────────────────────────────────────────────────────┘
        │  Tools may only fetch facts from here; if it is not there, say so
        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  Tool layer  tools.js (10 tools, trimmed per mode: 6 for case / 10 patrol) │
│  Every tool returns **evidence only** — never a conclusion or a class      │
│  Each call registers a citation id: T1, T2, …                              │
└────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  AI layer  ai.js — the tool-calling loop                                   │
│   model ──functionCall──▶ local tool execution                             │
│     ▲                        │                                             │
│     └──functionResponse──────┘        (up to 12 turns, MAX_TOOL_TURNS)     │
│  online failure → degrade to the offline rule path (labelled as such)      │
└────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  Execution layer  cluster.js (★ low-risk actions only) + actions.js (risk   │
│  hard-coded).  patchNode → read back → verified check → operation log      │
│  Medium/high risk is always refused, and the model is steered to           │
│  propose_fix so the action goes through human approval                     │
└────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
  Static front end (Firebase Hosting) → verdict card + evidence pack + tool trace
                                        + action list / approval + execution package
```

**Core principle**: every fact is produced deterministically by `kb.js` / `triage.js`; the AI only
**gathers evidence, infers, and registers**. Four consequences:

1. Numbers are reproducible and auditable — the AI can never "invent a figure";
2. With the model unavailable the system still demonstrates end to end (degrading to the rule path, which
   also produces structured recommendations);
3. Under technical review we can state precisely which part is model capability and which is engineering
   determinism;
4. Every number the model cites is traceable to a specific tool return value — the UI displays the trace so
   this can be verified live.

### The tool-calling loop (why this is a Gen AI implementation, not a wrapper)

```
contents = [prompt]
loop (at most MAX_TOOL_TURNS = 12 turns):
    resp = Gemini(contents, tools=[functionDeclarations for this mode])
    if it contains functionCall:
        contents += [model turn]           # returned verbatim, preserving the thinking model's thoughtSignature
        contents += [tool execution result]  # role is `user`, see below
        continue
    if it contains text: return text + accumulated tool_calls
```

**★ One turn ≠ one call.** The model can emit several `functionCall`s in a single turn (in practice it sent
4 `inspect_node` calls at once to sweep the nodes), so 12 refers to round trips.

**Model fallback chain**: each model has an independent daily free quota, so the app tries
`gemini-3.5-flash-lite → gemini-3.5-flash → gemini-3.1-flash-lite → gemini-3.8-flash` in order. It
distinguishes two kinds of 429: a short-term rate limit means wait and retry the same model; a daily quota
exhaustion (the response says `retry in 18h44m`) means **switch models immediately** — otherwise the UI
would hang for more than half a day. The reason for the switch is shown in the UI.

### Tool list

| Tool | Mode | Purpose |
|---|---|---|
| `search_failure_signature` | triage | Search the 27-entry failure-signature library (returns candidates, not conclusions) |
| `lookup_xid` | triage | Authoritative meaning, failure class and recommended handling for an Xid code |
| `check_compat` | triage | Validate driver / CUDA / torch / NCCL compatibility |
| `estimate_memory` | triage | Training memory accounting → comfortable / tight / will_oom |
| `inspect_node` | triage | Node telemetry: Xid event sequence, ECC, throttling, PCIe, 30-day history |
| `propose_fix` | triage | Register a remediation suggestion (pass `action_id`; risk comes from the library) |
| `scan_cluster` | patrol | Proactively sweep the cluster and return nodes needing attention (**symptoms**, not classes) |
| `execute_action` | patrol | Execute an action. **Only low-risk ones actually run**; medium/high return "human approval required" |
| `draft_ticket` | patrol | Prepare a ticket draft for a high-risk action (**never submits**) |
| `notify_operator` | patrol | Push the conclusion and the pending item to the on-call engineer |

**★ The tool list is trimmed per mode (`toolSpecsFor(mode)`).** Single-case triage is not connected to a
cluster at all, so `scan_cluster` / `execute_action` / `draft_ticket` / `notify_operator` are not merely
useless there: the model would waste a call, receive "this session is not connected to a cluster", and leave a
line in the call trace that looks like a fault. **Handing the model a key that cannot open a door is a design
failure, not the model's fault.**

## Security boundaries (stated plainly so they can be trusted)

**1. No connection to any real production cluster.**
The triage cases are constructed; the on-call nodes are simulated. The real Tencent Cloud / Alibaba Cloud /
Baidu Cloud / ZhiXingYun clusters have **no network path** to Google Cloud and are unreachable by design.
Only the methodology was transferred, not the data.

**2. The only actions the Agent may execute autonomously are low-risk ones.**
6 low / 5 medium / 3 high. "Low risk" means "affects only the current job process, reversible, touches neither
hardware nor the system" (for example cordon — it only blocks new jobs and **does not interrupt anything
already running**). `drain_node` evicts people and `reboot_node` kills jobs someone has been running for a
week; both are medium risk, and the model has no authority to execute them.

**3. The approval threshold lives in code, not in the prompt.**
A prompt is **persuadable** — the model only has to "believe" something is low risk to try to route around it.
So the threshold is code: in `execute_action`, `if (act.risk !== 'low') return refusal`, and that check is
ordered **before** the "is a cluster connected" check — approval is a rule, and rules are stated first.

**4. RMA is drafted, never submitted.**
`file_rma` is high risk: filing one RMA means the cluster loses a card. The Agent prepares the ticket to the
point where a human **only has to click confirm** (evidence, commands and rationale all filled in) but
**never submits it for you**. In the draft, `approved` / `ticket_no` / `approver` can only be written by a
human — those are the traces of a human signature.

**5. The Firestore rules allow anonymous read/write (a deliberate boundary, not an oversight).**
The browser has no login flow, so the demo environment cannot be anything else — **a production deployment
must switch to Auth-based rules**. The exposed surface is pinned by the rules to 4 collections
(`cluster` / `events` / `tickets` / `notifications`); every other path is denied, so even abuse cannot spill
into the project's other data.

**6. The front end holds a Firebase Web API key (that is Firebase's own design, not an oversight).**
The key is already public in the source of any Firebase web page; real protection comes from security rules
and App Check. **App Check is not yet enforced** (Firebase starts enforcing it for AI Logic on 2026-11-02),
so today a third party could in theory reuse the quota. Attaching an App Check token in the request header
closes it, with no change to business logic. This is an identified boundary with a concrete convergence step.

**7. What "proactive" actually means in this demo.**
The app is a purely static site with no long-running process. So the on-call sweep is a loop that **starts when
a human clicks and then runs itself to completion**. A real deployment should trigger it from Cloud Scheduler —
**this is stated in the UI, and we do not pretend there is a resident service.** Likewise, notifications land
in the `notifications` collection and stay `queued`; we do not pretend they were delivered to your IM.

## Repository layout

```
.
├── README.md / README.en.md      Chinese / English documentation
├── LICENSE                       MIT
├── firebase/
│   ├── package.json              only makes Node treat js/ as ES modules; the browser never reads it
│   └── public/                   ★ the live, deployed static site (no build step)
│       ├── index.html            page shell (four tabs)
│       ├── styles.css
│       └── js/
│           ├── kb.js             knowledge base: 24 Xid entries + 27 signatures + 6 principles + version matrix
│           ├── triage.js         deterministic pre-analysis: Xid extraction / signature match / compat / memory
│           ├── tools.js          10 tools + parameter allow-list + per-mode trimming
│           ├── actions.js        action library (risk hard-coded) + approval flow + execution package
│           ├── cluster.js        simulated-cluster client: execute → read back → verify → write operation log
│           ├── prompt.js         prompts (hard rules generated per mode)
│           ├── ai.js             AI layer: tool loop + fallback chain + resume + offline fallback
│           ├── app.js            UI wiring
│           └── data/
│               ├── cases.json            14 cases (incl. three contrast pairs)
│               └── cluster_seed.json     6 simulated nodes + telemetry history
├── scripts/
│   ├── verify_triage.mjs         invariant checks + F8 benchmark (offline, no quota)
│   ├── verify_pipeline.mjs       end-to-end contract test: stubbed fetch + in-memory fake cluster (offline)
│   ├── browser_check.mjs         real Chrome + real Firestore end-to-end acceptance
│   ├── record_demo.mjs           demo recording: walks the live site per storyboard → frames + timeline
│   ├── demo_voice.py             English narration: per-shot synthesis, measured, fitted to each window
│   ├── demo_caption.py           burns bilingual captions + progress bar, mixes the voice, encodes the mp4
│   ├── capture_shots.mjs         captures the full-page readings used in the deck
│   │                             (`--boxes` also measures element geometry, for cropping)
│   ├── fb_deploy.py              publish to Firebase Hosting (plain REST)
│   ├── fb_firestore_setup.py     simulated-cluster backend: check / rules / seed / verify
│   └── probes/                   one-off probes that established the AI Logic behaviour
├── shots/                        full-page readings for the deck, captured from the live site (two sets)
│   ├── clean/                    the just-reset UI: cluster card, node rows, risk block, bench table
│   ├── shift/                    after one patrol run: op-log non-empty, one real triage call made
│   └── */boxes.json              element geometry measured in the same screenshot session (no hand-written coords)
├── deck/
│   ├── slides/01..14.slide       slide DSL source (three-zone master, 1280×720)
│   ├── assets/                   the 7 crops used in the deck (regenerated by make_crops.py)
│   ├── make_crops.py             crops shots/: geometry from boxes.json, frames from slides/
│   ├── make_pdf.py               render/*.png → ../docs/…deck.pdf (white background + 150dpi)
│   ├── DESIGN.md / STORY.md      layout rationale and page-by-page outline
│   └── Training-Failure-Triage.pptx   the editable form of the deck
└── docs/
    ├── architecture.md           Architecture and design basis (Chinese)
    ├── architecture.en.md        Architecture and design basis (English)
    ├── scenarios.md              Scope and functional specification (Chinese)
    ├── demo-script.md            Storyboard + recording/composing notes (Chinese)
    ├── demo-script.en.md         Storyboard + recording/composing notes (English)
    ├── Training-Failure-Triage-deck.pdf      Solution deck (14 pages)
    └── Training-Failure-Triage-demo.mp4      Demo video
```

> `shots-demo/` is not fully committed — tens of thousands of frames are not worth the size.
> `.gitignore` excludes `frames/`, `captioned/` and the per-shot audio in `voice/`; `timeline.json`,
> `beats.json` and `voice.m4a` stay, because together they record how the film was actually assembled.
>
> **The deck's screenshots and layout are rebuildable too**, not pasted-in finished images: `shots/`
> holds full-page captures taken from the live site by `scripts/capture_shots.mjs`, `deck/make_crops.py`
> cuts the 7 evidence crops out of them, and `deck/make_pdf.py` assembles the 14 pages into the PDF.
> **Nothing hand-writes crop coordinates** — the geometry comes from `boxes.json`, measured in the same
> session as the capture, and the image frame size is read back from `slides/*.slide`. The previous
> version's six hand-written coordinate sets all went stale after one UI redesign, and nothing reported
> it: same numbers, every element moved, crops sliced through half a panel.
>
> `shots/` comes in two sets because **the UI can only be in one state at a time**: `clean/` is the
> just-reset view (the cluster card, node rows, risk block and bench table need this one), `shift/` is
> after a patrol run (the op-log is only non-empty then, and one real triage call has been made).
> Using the post-patrol state to illustrate "what the page looks like on load" would put the picture at
> odds with the caption.
>
> `deck/render/` (14 pages at 1920×1080) and `deck/.slidep/` (tool state) are not committed — both can
> be rebuilt from the DSL.

## Submission checklist

- [x] **Public** GitHub repository (this repo)
- [x] Accessible deployed prototype link — <https://gpu-waste-auditor-2026.web.app>
- [x] Demo video (**under 3 minutes**) — final cut at
      [docs/Training-Failure-Triage-demo.mp4](docs/Training-Failure-Triage-demo.mp4), storyboard and
      recording/composing notes in [docs/demo-script.en.md](docs/demo-script.en.md)
- [x] Solution deck — [docs/Training-Failure-Triage-deck.pdf](docs/Training-Failure-Triage-deck.pdf) (14 pages)
- [x] Code written during the competition period
- [x] English documentation ([README.en.md](README.en.md), [architecture.en.md](docs/architecture.en.md), [demo-script.en.md](docs/demo-script.en.md)) — for the JAPAC reviewing panel

## Known limitations and uncertainties

1. **The knowledge base covers 24 Xid codes and 27 failure signatures**, not all 100+ Xid codes.
   That is a design decision, not laziness: **the knowledge base boundary is the model's capability
   boundary** — when an entry is missing the tool returns "no record, do not speculate", and the prompt
   requires the model to say it does not know. Inventing a plausible-sounding explanation is far worse than
   saying "I don't know", because an operator will act on it in production.
2. **The AI triage accuracy is not claimed by us**; it is tallied automatically on the page after all 14 cases
   have run, and stays blank until then. Nothing that has not been measured appears anywhere.
   The rule baseline of **11/14** is reproducible on the spot (local, instant, no quota).
3. **Remediation commands are given in generic-tool terms** (`nvidia-smi` / `dmesg` / `modprobe` / `kubectl`)
   and are not bound to any particular scheduler. Wherever a cluster platform is involved, the `note` field
   says "replace this for your platform", and anything in `<angle brackets>` is a placeholder to substitute.
   **We would rather state clearly what needs replacing than pretend one command fits every cluster.**
4. **The execution package has no automatic execution capability whatsoever**: commands must be copied to the
   target node by a human. This is deliberate — the most dangerous thing in an execution package is not a
   mistyped command, it is **an unapproved command that gets executed**. So an action without a rollback does
   not enter the package, and unapproved actions are explicitly marked "not approved, do not execute".
5. **The free tier is the hardest constraint during the demo**:

   | Item | Value | How it was obtained |
   |---|---|---|
   | Model requests per patrol | **12–16** | **Derived from tool rounds** (one request per round; fewer when the model parallelises calls). Not read off a quota counter |
   | When the turn cap triggers a resume | one more batch | `MAX_RESUMES = 2` in `ai.js` |
   | Free daily quota per model | about **20 requests/model/day** | Measured (2026-10-14) |
   | In practice | **roughly 5–6 patrols per day** | Derived from the two rows above |
   | Duration of one full patrol | **15–40 s** when things go well; **90–120 s** if an upstream 500 triggers a resume | Measured |

   Single-case triage **has a local cache**: a cache hit costs zero requests and zero waiting, so it is
   unaffected by quota on recording day. The on-call patrol has no cache (it genuinely runs every time) —
   this is called out in the pre-recording checklist.

6. **An occasional upstream 5xx triggers a "resume" rather than a restart**, but with a cap
   (`MAX_RESUMES = 2`). The resume carries completed tool calls over to the next model and continues; the UI
   shows "an upstream failure occurred once, resumed with progress". If failures exceed the cap it still
   degrades to the rule path.
7. **The official AI Logic JS SDK is not used**, because it has a hard defect in multi-turn tool calling:
   the SDK hard-codes the role for returning tool results as `function`, which current models no longer
   accept, while switching to `user` is blocked by the SDK's own client-side validation. See section 3 of
   [docs/architecture.en.md](docs/architecture.en.md). The cost is handling auth and timeouts ourselves; the
   benefit is full control over the `contents` roles and 150 KB less dependency weight.
8. **The UI and prompts are currently in Simplified Chinese.** There is no API surface to be affected (this is
   a pure front-end app). An English UI is an explicit follow-up; this document does not claim it is done.

These limitations will be raised during technical review; this document lists them as known boundaries
rather than avoiding them.

## Licence

[MIT](LICENSE)
