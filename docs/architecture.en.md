# Architecture

**Language:** 🇬🇧 English ｜ [🇨🇳 中文](architecture.md)

> This document describes the **design rationale**, not the feature list. For the scope and functional
> specification see [scenarios.md](scenarios.md) (Chinese); for the demo storyboard see
> [demo-script.en.md](demo-script.en.md).

## 1. Problem definition

The most expensive mistake in a training cluster is not a missed alert — it is **getting the direction wrong**.
Both directions are real:

| Mistake | How it looks | What it costs | What public sources say |
|---|---|---|---|
| **Treating an application bug as a hardware fault** | See Xid 13 / 31 / 43 and file an RMA | A good card is retired, an RMA is filed, capacity is wasted | "Do not file an RMA for a user's bug" — Xid 13/31/43 **follow the buggy job**; a different node reproduces it while the hardware is fine |
| **Treating hardware degradation as a one-off** | See Xid 94 and say "just restart it" | Degradation accumulates until Xid 95 appears and the blast radius has grown | A single event is often harmless; **the change in rate is the signal** |

Both mistakes **can be triggered by the same error code** (in the case library, `case-xid94-single` and
`case-xid94-rising` are the same Xid 94 on the same GPU model, with opposite conclusions). So the
discriminating evidence cannot be the code itself; it can only be:

1. **Trend** — is the 30-day frequency rising, is correctable ECC rising in step;
2. **Causal chain** — codes like Xid 45 / 154 **describe only the consequence**; treating them as the root
   cause sends you the wrong way;
3. **Kernel and process state** — Xid 62 present or the process in D state → look at driver/hardware;
   zero Xids and the process waiting in futex → look at the code.

Conventional monitoring answers "what is the Xid"; it never answers **"should we replace the card"**.
This project supplies that step, and compresses the answer into two fields that **can be falsified on the spot**:

- **Six-way classification**: `application` / `hardware` / `hardware_watch` / `environment` / `config` /
  `network` / `undetermined`
- **RMA decision** (`should_rma`): a boolean

## 2. Layers and data flow

```
Case library (14 cases, incl. three contrast pairs)   Simulated cluster (Firestore, 6 nodes)
   firebase/public/data/cases.json                       firebase/public/data/cluster_seed.json
          │                                                      │
          ▼                                                      ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│  ① Knowledge base layer   kb.js                                               │
│     24 Xid entries (each with an official doc URL) ｜ 27 failure signatures ｜  │
│     6 diagnostic principles ｜ version matrix (torch↔CUDA, CUDA↔min driver,    │
│     driver↔CUDA ceiling) ｜ memory specs and aliases                          │
│     Every fact carries a `source` field. This file is the single source of     │
│     "checkable".                                                              │
└───────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│  ② Deterministic pre-analysis layer   triage.js (pure functions, unit-testable)│
│     Extract Xids ｜ match signatures ｜ validate version stack ｜ memory        │
│     accounting ｜ tally weighted "votes"                                       │
│     Output: confirmed (established facts) + hints (leanings, explicitly        │
│     labelled as leanings rather than conclusions)                              │
│     The same module also provides ruleBasedTriage() — the F8 baseline and the  │
│     offline fallback path                                                      │
└───────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│  ③ Tool layer   tools.js                                                      │
│     10 tools, trimmed per mode (6 for single-case triage / 10 for patrol)      │
│     ★ They return evidence only — never a conclusion, never a classification   │
│     Each call registers a citation id via _cite(): T1, T2, …                   │
│     The parameter allow-list TOOL_PARAMS is also the security boundary         │
└───────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│  ④ AI layer   prompt.js + ai.js                                               │
│     Prompts generate hard rules per mode; tool-calling loop; model fallback    │
│     chain; resume; offline fallback                                           │
│     Online failure → degrade to the rule path, labelled "no model was called"  │
└───────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│  ⑤ Execution layer   actions.js (risk hard-coded) + cluster.js (real effect,   │
│  then read back)                                                              │
│     Only actions with risk === 'low' are actually executed by execute_action   │
│     Medium/high are always refused and the model is steered to propose_fix so  │
│     the action goes through human approval                                     │
│     patchNode → read back → verified check → write operation log               │
│     The product of a high-risk action is a ticket draft, not an environment    │
│     change                                                                     │
└───────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
   Static front end (Firebase Hosting, no build step)
   → verdict card + evidence pack + tool-call trace + action list / approval + execution package
```

**Layering principle**: every **fact** is produced deterministically by `kb.js` / `triage.js`; the AI only
**gathers evidence, infers, and registers**. Four consequences:

1. Numbers are reproducible and auditable — the AI can never "invent a figure";
2. With the model unavailable the system still demonstrates end to end (degrading to the rule path, which
   also produces structured recommendations);
3. Under technical review we can state precisely which part is model capability and which is engineering
   determinism;
4. Every number the model cites is traceable to a specific tool return value — the UI displays the trace so
   this can be verified live.

## 3. The AI layer: the tool-calling loop

```
contents = [prompt]
loop (at most MAX_TOOL_TURNS = 12 turns):
    resp = Gemini(contents, tools=[functionDeclarations for this mode])
    if it contains functionCall:
        contents += [model turn]             # parts returned verbatim, preserving the thoughtSignature
        contents += [tool execution result]  # role is `user`, not `function` — see 3.1
        continue
    if it contains text: return text + accumulated tool_calls
    neither: throw (attaching completed calls as `resume`)
```

### 3.1 Role discipline for `contents`

| Segment | role | Note |
|---|---|---|
| User prompt | `user` | initial input |
| Model-issued tool calls | `model` | **return the `parts` verbatim**, do not rebuild — the thinking model's `thoughtSignature` must stay untouched |
| Tool execution results | **`user`** | see below |

**Why tool results carry role `user` and not `function`** (this was learned the hard way; do not retry it):

- Current models no longer accept `function`; the server returns
  `400 Role 'function' is not supported. Please use a valid role: SYSTEM, USER, ASSISTANT, …`;
- Switching to `user` is the correct fix, but it is blocked by the official JS SDK's own client-side
  validation (`Content with role 'user' can't contain 'functionResponse' part`).

Both routes are blocked, so `ai.js` **talks to the REST endpoint directly**, controlling the `contents` roles
itself and dropping a 150 KB dependency. Measured (`scripts/probes/probe_tool_roundtrip.py`): with role
`function`, only `gemini-3.1-flash-lite` still works; with role `user`,
`gemini-3.5-flash-lite` / `gemini-3.5-flash` / `gemini-3.1-flash-lite` all pass.

> Authentication must use the header `x-goog-api-key`. Using the query parameter `?key=` makes the edge return
> an HTML 400, which looks like "model does not exist" and is easily misdiagnosed as the model being retired.

### 3.2 Turn limit and resume

**★ One turn ≠ one call.** The model can emit several `functionCall`s in a single turn (in practice it sent
4 `inspect_node` calls at once to sweep the nodes), so `MAX_TOOL_TURNS` counts **round trips**.

The value is **12**. Why not 8: a full patrol (scan → per-node evidence → knowledge lookup → stop the bleeding
→ draft ticket → notify → report) takes **13 turns** when the model does not parallelise, so 8 would
**guarantee truncation** — and the price of truncation is restarting from scratch on another model: slower,
more expensive, and it **sweeps the cluster a second time**.

**Resume**: on an upstream 5xx, `{ contents, toolCalls, turns }` is attached to the error object and
`tryModelChain` carries it across models so the run **continues rather than restarting**. The cap is
`MAX_RESUMES = 2`.

Attaching a resume is deliberately restricted to two cases:

| Situation | Attach resume? | Reason |
|---|---|---|
| Transport / upstream failure (the request never succeeded) | ✅ yes | That turn produced no state, so retrying is side-effect free |
| Hit the turn limit **with at least one completed call** | ✅ yes | The criterion is simply "completed calls are worth carrying" |
| The model loops without converging and made no calls at all | ❌ no | Continuing would just keep looping and burn quota |

**The original failure, measured in production**: the first patrol turn ran 13 calls, hit the limit, and
because no resume was attached the whole thing was discarded — the next model swept the cluster from scratch.
The symptom hid in the UI: **the citation table listed T1…T18 while the call trace showed only 5 entries**,
with `T14 = scan_cluster` appearing a second time. "The evidence chain" and "what actually happened" did not
match — and that is precisely the core selling point of the whole project.

### 3.3 Model fallback chain and the two kinds of 429

Each model has an independent free daily quota, so the app tries
`gemini-3.5-flash-lite → gemini-3.5-flash → gemini-3.1-flash-lite → gemini-3.8-flash` in order. It
distinguishes two kinds of 429:

| Situation | Criterion | Handling |
|---|---|---|
| Short-term rate limit | suggested wait ≤ 90 s | wait and retry **the same model** (at most twice) |
| Daily quota exhausted | response says `retry in 18h44m` | **switch models immediately** — waiting would freeze the UI for over half a day |

The reason for the switch is shown in the UI (`degraded`), and we do not pretend it worked first time.

### 3.4 The single exit point for results

Both `diagnose` and `patrol` must go through `finishResult(state, mode, text, extra, error)`, which
**spreads the whole package and picks no fields**. It exists because of a real bug: the two entry points
originally each had a local `finish()` that looked like this —

```js
packResult(state, { mode, text, model: extra.model || '', error });
if (extra.degraded) out.degraded = extra.degraded;
```

i.e. **only `model` and `degraded` were picked out**. So `tool_calls` was dropped silently: the model had
called `lookup_xid` / `inspect_node` (every one recorded in `citations`), yet the UI's "AI tool-call trace"
permanently read "no tools were called this time". **What was hidden was the single most valuable piece of
evidence in the demo.** Worse, the same screen still said "generated by gemini-… calling tools autonomously"
— two statements contradicting each other.

`finishResult` also encodes two **invariant checks**, surfacing a `pipeline_error` in the UI when violated:

```js
// Shape guarantee for the online path: runAgent starts from `const toolCalls = []`, so it always
// returns an array. If mode is gemini and tool_calls is not an array, there is exactly one
// explanation — the packaging dropped fields again.
const broken = mode === 'gemini' && !Array.isArray(extra.tool_calls);

// Second invariant: every citation corresponds to one tool call. Citations are registered when a tool
// actually runs, at most one per call, so "citations > calls" is mathematically impossible — if it
// happens, a batch of call records was lost.
const lostWork = (state?.citations || []).length > calls.length;
```

## 4. Mode is the capability boundary (not just a prompt difference)

The app has two entry points, and they differ **not only in wording but in the tool set itself**:

| | Single-case triage `diagnose()` | On-call patrol `patrol()` |
|---|---|---|
| Input | a failure scene pasted by the user | an empty evidence pack plus an entire cluster |
| Tool count | **6** | **10** |
| Extra tools | — | `scan_cluster` / `execute_action` / `draft_ticket` / `notify_operator` |
| End state | judgement + plan + execution package | judgement + **actually acting** + ticket + outreach |

Trimming happens in `tools.js: toolSpecsFor(mode)`; hard rules are generated per mode in
`prompt.js: hardRules(mode)`.

**Why trim**: single-case triage **is not connected to a cluster at all**. Giving it `execute_action` is not
merely useless — the model would waste a call, receive "this session is not connected to a cluster", and leave
a line in the call trace that looks like a fault. This really happened during the first browser acceptance run:
in single-case triage the model called `notify_operator` and got back "cannot deliver notification".

> **Handing the model a key that cannot open a door is a design failure, not the model's fault.**

Conversely, **the prompt must agree with the declared tool set**. `hardRules(mode)` is a function rather than a
constant for precisely this reason: hard-coding "call `propose_fix` / `execute_action`" would make the
single-case prompt instruct the model to use a tool it does not have, so its very first attempt would be
guaranteed to fail.

## 5. Knowledge base layer (`kb.js`)

**Why all facts live in one file**: the entire credibility of the triage rests on one thing —
**a conclusion must land on a checkable fact**. So every entry carries a `source` field pointing at an
authoritative reference (NVIDIA Xid docs / GPU debugging and memory-error management guide / public cluster
RAS knowledge bases / PyTorch and CUDA official compatibility tables). The model can only read these facts
through tools; what it cannot read, it has no right to conclude. **That works far better than a prompt saying
"do not fabricate".**

| Content | Size | Detail |
|---|---|---|
| Xid table | **24 entries** | meaning, failure class, severity, recommended handling, whether an RMA is needed, source |
| Failure signatures | **27 entries** | non-Xid errors (OOM, NCCL timeout, driver gone, GPU hang, …) with regex + typical root cause + what to verify |
| Diagnostic principles | **6** | first-event rule T0 / secondary events are not root causes / symptom ≠ cause / trend over snapshot / do not conflate / no RMA for application bugs |
| Version matrix | 3 tables | torch↔CUDA, CUDA↔minimum driver, driver↔CUDA ceiling |
| Memory specs | 14 models + aliases | used for memory accounting |

Several **deliberate design decisions**:

- **`class_hint` is a default leaning, not a conclusion.** Tools label it explicitly as a hint and require the
  model to combine `lookup_xid` / `inspect_node` / `check_compat` before classifying.
- **Record disagreements, do not smooth them over.** Xid 43's classification **differs between authoritative
  sources** (the NVIDIA ops knowledge base and Alibaba Cloud's ACK docs call it an application problem;
  another open diagnostic table calls it hardware/driver). The knowledge base records the disagreement as-is
  and states "for 43 you must check whether 48 / 95 / 79 also occurred in the same window: if so treat it as
  hardware, if not treat it as application". **That is not a defect in the knowledge base — it is the reason
  triage has to exist.**
- **Conditional handling must state its precondition.** Xid 62's action reads "if it co-occurs with Xid 79 or
  recurs, escalate to a hardware investigation", with `rma: null`. This precondition was added after being
  burned: the patrol prompt initially only had the model call `inspect_node` and never told it to consult the
  knowledge base, so the model went on impression, treated Xid 62 as a hardware write-off, and drafted an RMA
  ticket for a node that **should not have been reported at all**. The fix touched two places — `PATROL_TASK`
  now requires `lookup_xid` for **every** Xid in the telemetry, and `DIAGNOSTIC_DISCIPLINE` gained a
  "conditional handling" rule. **One skipped knowledge lookup costs you a card that was still usable.**

## 6. Deterministic pre-analysis layer (`triage.js`)

Pure functions, zero dependencies, directly unit-testable in Node. It produces two things and **strictly keeps
them apart**:

| Output | Nature | Who consumes it |
|---|---|---|
| `confirmed` | **Established facts** — Xids and their counts, matched signatures, whether the version stack is consistent, memory requirement vs capacity | Listed in a dedicated prompt section, labelled "computed by deterministic code; you do not need to recompute" |
| `hints` | **Leanings** — weighted votes across sources | Labelled in the prompt as "this is a machine vote, not a conclusion. If the evidence you fetch conflicts, follow the evidence" |

That separation is not formalism: presenting the votes as conclusions would make the model copy them, and the
whole thing would degrade into a lookup table — which the F8 benchmark already showed to be insufficient.

The same module also exposes `ruleBasedTriage()`, which **does the two most naive things only**: take the
highest-voted classification; if it is `hardware`, recommend an RMA. It is used in three places:

1. **the F8 baseline comparator** (see §10);
2. the **offline fallback path** (`offlineCaseTriage`);
3. as the source of the reproducible number in `verify_triage.mjs`.

> ⚠️ **Do not "improve" this function to make the baseline look better** — that turns the comparator into an
> AI as well. Treat it as "the ceiling of naive rules" and report honestly which cases it gets wrong.

## 7. Tool layer (`tools.js`)

**The intent in one line: the danger in triage is not a model that is too weak, it is a model that fabricates
too cleverly.** So all 10 tools do one thing — **return evidence**. They never return a conclusion, and never
return a suggested classification.

| Tool | Mode | Input | Output | Why it must come from a tool |
|---|---|---|---|---|
| `search_failure_signature` | triage | `query` | candidate patterns + typical root cause + what to verify | stops the model "recalling" failure patterns |
| `lookup_xid` | triage | `code` | authoritative meaning, class, handling, RMA | the knowledge base is external fact the model has no access to |
| `check_compat` | triage | driver / cuda / torch / nccl | per-item validation results | the version matrix is a hard rule needing exact comparison |
| `estimate_memory` | triage | training config | memory range + fit verdict | requires exact arithmetic the model cannot do reliably |
| `inspect_node` | triage | `node` | telemetry: Xid sequence, ECC, throttling, PCIe, 30-day history | **the only basis for "one-off vs degrading"** |
| `propose_fix` | triage | `action_id` + conclusion fields | registers one recommendation | recommendations must be structured to render as decision items |
| `scan_cluster` | patrol | `include_healthy?` | nodes needing attention (**symptoms**) | the entry point for proactive discovery |
| `execute_action` | patrol | `node` / `action_id` / `reason` / `params` | execution result + **verification verdict** | execution must land somewhere auditable |
| `draft_ticket` | patrol | ticket fields + `evidence_refs` | draft ticket id | the product of a high-risk action is a ticket |
| `notify_operator` | patrol | `node` / `title` / `text` | delivery result | proactive outreach |

### 7.1 Citation ids: making "traceable" visible

`ToolState._cite(source, payload)` registers a citation each time a tool actually runs and returns `T1`, `T2`, …
The model references them from `propose_fix` / `draft_ticket`, so the UI can link every recommendation back to
the call that produced it.

Citations the model invents are **dropped and reported back**:

```js
const validRefs = evidence_refs.filter((r) => this.citations.some((c) => c.ref === r));
// droppedRefs goes into the return value, telling the model: only refs that appeared in tool
// return values may be used.
```

### 7.2 The parameter allow-list is also the security boundary

`TOOL_PARAMS` keeps only the fields on the allow-list. The model occasionally passes extra arguments
(**it has even tried to pass a `risk` to re-grade an action**), and fields not in the table **cannot get in at
all**.

**★ The table deliberately does not list method names**: on `ToolState`, method names are identical to tool
names, and dispatch calls the method by tool name. The original form was `{ tool_name: [method_name, allowlist] }`,
so one name had to be maintained twice (`lookup_xid` and `lookupXid`). Change one and forget the other, and
`dispatchTool`'s try/catch swallows it into a generic "that tool errored" — the model only sees "this tool is
broken", and the real cause is buried in the dispatch table, essentially undiscoverable by reading the code.
**Five of the six tools were broken at the time**, and only surfaced when the self-check script compared them
one by one. That class of misalignment is now structurally impossible.

### 7.3 Tool exceptions do not abort the session

`dispatchTool` catches exceptions and returns them to the model as an **informative failure** (`{ error: … }`)
instead of aborting the diagnosis. The price is that it swallows exceptions — which is why tool names and
method names must be kept identical by construction (see 7.2).

## 8. Execution layer: approval and verification

### 8.1 The three risk levels follow the **blast radius**, not difficulty

| Risk | Rule | Approval requirement | Count |
|---|---|---|---|
| **Low** | affects only the current job process, reversible, touches neither hardware nor system | **bulk approval in one click** | **6** |
| **Medium** | affects other jobs on the node, or needs a brief interruption | **per-item approval + tick to acknowledge the blast radius** | **5** |
| **High** | irreversible, involves hardware assets, cross-node or affecting others | **per-item approval + change-ticket number and approver required + second confirmation** | **3** |

The deciding factor is blast radius rather than difficulty: **installing a wheel can be a pain, but it only
affects one container, so it is low risk; rebooting a node is one command, but it kills a job someone has been
running for a week, so it is medium risk.**

There is also **1 action explicitly marked "discouraged"**: `raise_nccl_timeout`.
The knowledge base states it **masks the problem rather than solving it** — it turns a failure from "times out
after 30 minutes" into "times out after 2 hours", with not one root cause fewer, only discovered later. The
library keeps it and the UI greys it out, but it is **excluded from the candidate list given to the model**.
Letting the system say plainly "we know about this route and do not recommend it" shows more judgement than
pretending it does not exist.

### 8.2 ★ Risk levels do not come from the model

Each action in the library **carries its own `risk` field**. The model can only **select** an action (via
`action_id`); it cannot **set** a level. Two enforcement points in `tools.js`:

```js
// ① execute_action: only low risk is actually executed
if (act.risk !== 'low') {
  return { refused: true, error: `"${act.label}" is a ${lv.label} action … you are not authorised to run it.`,
           instead: 'Register it with propose_fix … and hand it to the human approval flow' };
}

// ② propose_fix: the level is taken from the library, no model field is read
const action = { risk: act.risk, risk_label: RISK_LEVELS[act.risk].label, approval_requirement: … };
```

**★ Order matters: the safety rule comes before the availability check.** That order was forced by the
self-check script — originally the "is a cluster connected" check came before the risk check, so with no
cluster the model received "no cluster connected" rather than "you are not authorised to run this action".
In a real on-call setting the model reads the former as **"just connect and try again"** — it misreads the
approval threshold as an environment problem. **Approval is a rule, and rules are stated first.**

### 8.3 Simulated cluster backend (Firestore): making "execution is real" true

**Why this backend has to exist**: if "execution" only greys out a button and rewrites copy to "handled", it is
indistinguishable from a slide deck and any reviewer sees through it immediately. So there is a **simulated
cluster with real state**.

| Collection | Purpose |
|---|---|
| `cluster` | state and telemetry of 6 nodes (`cordoned` / `schedulable` / `draining` / `jobs` / `telemetry` …) |
| `events` | **operation log**: each record holds `before` → `fields_written` → `after` → `verified` |
| `tickets` | ticket drafts (`status: 'draft'`) |
| `notifications` | notification queue (`status: 'queued'`) |

The security rules allow anonymous read/write because the browser has no login flow — an explicit security
boundary, not an oversight. The exposed surface is pinned to these 4 collections; every other path is denied.
`scripts/fb_firestore_setup.py` handles `check` / `rules` / `seed` / `verify`.

**What each action actually changes** lives in `cluster.js`'s `EFFECTS` table, three parts each, all required:

```js
cordon_node: (n) => ({
  fields: { cordoned: true, schedulable: false },                    // really written to Firestore
  verify: (a) => a.cordoned === true && a.schedulable === false,     // how it is judged to have taken effect
  describe: `no new jobs on ${n.node}; its ${(n.jobs||[]).length} running jobs are unaffected`,
}),
```

**An action without `verify` is not allowed to be registered** — because "executed but unverified" is not
executed at all, just logged somewhere else. Idempotence is also required: a patrol may trigger the same
action twice, and repeating `cordon` must neither error nor produce a second, semantically duplicate record.

**The full execute → verify chain** (`executeAction`):

```
before = getNode(node)            # state before
planned = effect(before, params)  # compute what to write
after  = patchNode(node, fields)  # ★ really written to Firestore (updateMask; other fields untouched)
verified = planned.verify(after)  # ★ read it back yourself to confirm
write events (status: ok | unverified | error)
```

When verification fails the event records `unverified` and the UI shows "verification failed".
**We would rather display a failed action than claim a false success** — a fake success in a demo collapses
the moment a reviewer asks "did the data actually change?".

### 8.4 RMA is drafted, never submitted

`file_rma` is high risk: filing one RMA means the cluster loses a card. So `draft_ticket` creates only a
`status: 'draft'` ticket, with evidence, commands, serial-number locations and rationale all filled in so that
**a human only has to click confirm**. In the draft, `approved` / `ticket_no` / `approver` **can only be
written by a human in the UI** — those are the traces of a human signature.

This is product judgement rather than a missing capability: **low risk it does itself; high risk it lowers the
bar to a single click but leaves the decision with a person.**

## 9. The four anti-hallucination disciplines

The whole design compresses into four disciplines, each enforced in **both** the prompt **and** the code:

| Discipline | What the prompt says | How the code guarantees it |
|---|---|---|
| **Numbers may only come from tools** | "Numbers the tools did not give you must not appear in your answer" | memory/version come from exact computation; citation ids can only come from `citations`; invented refs are dropped and reported |
| **Risk levels are not negotiable** | "You cannot declare or modify an action's risk level" | `execute_action` only lets `risk === 'low'` through; the `TOOL_PARAMS` allow-list means the model cannot even pass a `risk` field |
| **If it is not in the knowledge base, say so** | "Inventing a plausible-sounding explanation is far worse than saying 'I don't know'" | a missing entry returns "no record, do not speculate"; everything outside the table falls back to `undetermined` |
| **The moment a tool gives a conclusion, triage degrades into a lookup table** | — | `nodeSignals()` / `scan_cluster()` describe symptoms only, never a classification |

> Why both: **a prompt alone is persuadable, while code alone makes the model repeatedly hit a wall it does
> not understand.** Both are needed, but **the code is what ultimately takes effect.**

## 10. F8 benchmark: why a model is required (a reproducible comparison)

"This is something rules do badly, so a model is required" is a **falsifiable** claim, so we actually ran it
to try to falsify it.

`scripts/verify_triage.mjs` runs the entire **14-case** library through the **pure rule path**. Measured
result (directly reproducible):

```
Rule baseline accuracy (classification AND RMA decision both correct): 11 / 14  (78.6%)
  Classification only: 11 / 14   RMA decision only: 12 / 14
```

| Case | Expected | Rule says | What the rule cannot read |
|---|---|---|---|
| `case-xid48-dbe` | hardware + RMA | application | Xid 45 is "a consequence of a preceding error"; treating it as the root cause sends you the wrong way |
| `case-xid94-rising` | hardware + RMA | hardware_watch | Same code, same GPU model as `case-xid94-single`; the discriminator is the trend |
| `case-gpu-hang-deadlock` | application | network | Both this and `case-gpu-hang-xid62` are "training hang"; the discriminator is whether the kernel log is clean and whether the process is in D state |

**Only two fields are compared** (`class` and `should_rma`), because they are **booleans that can be falsified
on the spot** — far more objective than judging how well the prose reads.

The size and distribution of the case library are themselves designed:

```
Cases: 14   requires RMA: 4   does not: 10
Class distribution: config 2  network 1  application 2  environment 4  hardware 4  watch 1
Contrast pairs (demo assets):
  · Same code, opposite conclusion (Xid 94):  case-xid94-single  vs  case-xid94-rising
  · Driver gone (same sentence, opposite conclusion):  case-driver-nvml-mismatch  vs  case-smi-driver-dead
  · GPU hang (same symptom, opposite direction):  case-gpu-hang-xid62  vs  case-gpu-hang-deadlock
```

> ⚠️ **Honesty constraint**: the numbers in the benchmark table must come from an actual run. If it comes out
> 11/14, write 11/14 and say which cases were wrong and why. Fabricating an accuracy figure is the easiest
> thing to be caught on live. That is why `verify_triage.mjs` carries the comment "this number goes into the
> deck and the UI, so it must come from an actual run, not from someone's sense of what it should be".
> The AI side of the table follows the same rule — tallied automatically once all 14 cases have run, blank
> until then.

## 11. Engineering verification methodology: three scripts, three bug classes

| Script | Assertions | The **only** thing it can catch | Why nothing else can replace it |
|---|---|---|---|
| `verify_triage.mjs` | all pass | action-library invariants, whether the approval threshold really blocks, whether the model can bypass risk levels, case-library structure | does not run the pipeline and does not touch a browser |
| `verify_pipeline.mjs` | **81 / 81** | **silently dropped `tool_calls`** — this class of field loss in the pipeline | cannot be found by reading code (the two `finish()`s were a hundred lines apart and identical in shape), nor by invariant checks (they do not run the pipeline) |
| `browser_check.mjs` | **31 / 31** | that the UI actually runs, that there are no console errors from *our* side, that execution really lands in the database | `app.js` calls `init()` at module top level and is all `document.querySelector`; in Node, **the module resolving does not mean the UI runs** |

The division of labour is deliberate:

- `verify_pipeline.mjs` uses a **stubbed fetch plus an in-memory fake cluster** — no network, no Firestore, no
  model quota — so it can be run frequently;
- `browser_check.mjs` uses **real Chrome plus real Firestore** and is the only end-to-end acceptance. It cannot
  be replaced by `--dump-dom`, which shows only the final HTML and misses console exceptions — and the very
  thing to catch is a silent failure such as "an import path is wrong so an entire tab renders blank".

Three lessons from building these, worth recording:

1. **A fake object's shape must match the real one.** The fake cluster's `event` was missing the `verified`
   field, so P2 reported "the verification field was not carried through" — investigating showed the real code
   was correct and the fake object was wrong. **If a fake object's shape differs from the real thing, the test
   is proving a fact that does not exist.**
2. **A static guard must strip comments before matching.** The P0 section uses a regex to forbid the
   hand-rolled `packResult(state, { mode, text, model:` shape, and matched the bad pattern **deliberately
   quoted as a counter-example inside `finishResult`'s doc comment** — a false alarm on the first run.
3. **A check that is always red is no check at all.** An upstream Vertex AI 500 is a **real-world condition we
   handle**, not a defect in our code — but the browser still records it as a console error. So the assertion
   only inspects errors from *our* side, while upstream failures are counted separately and printed honestly
   (not hidden).

## 12. Known limitations

1. **The knowledge base covers 24 Xid codes and 27 failure signatures**, not all 100+ Xid codes. A design
   decision, not laziness: **the knowledge base boundary is the model's capability boundary.**
2. **The AI triage accuracy is not claimed by us**; it is tallied automatically by the page and stays blank
   until all cases have run. The rule baseline of **11/14** is reproducible on the spot (local, instant, no
   quota).
3. **Remediation commands are given in generic-tool terms** and are not bound to any scheduler; wherever a
   cluster platform is involved the `note` says "replace this for your platform". **We would rather state what
   needs replacing than pretend one command fits every cluster.**
4. **The execution package has no automatic execution capability at all**: commands must be copied to the
   target node by a human. The most dangerous thing in an execution package is not a mistyped command but
   **an unapproved command that gets executed** — so an action without a rollback does not enter the package,
   and unapproved actions are explicitly marked "not approved, do not execute".
5. **What "proactive" really means in this demo**: the app is a static site with no long-running process, so
   the patrol is a loop **started by one click and then runs itself**. A real deployment should trigger it from
   Cloud Scheduler — this is stated in the UI.
6. **Notifications are only enqueued, never actually sent**: they land in `notifications` and stay `queued`.
   A real deployment needs an IM / email integration.
7. **The free tier is the hardest constraint during the demo** (measured 2026-10-14): one patrol is about
   12–16 model requests, a single model's free daily quota is about 20 requests → **roughly 5–6 patrols per
   day**. Single-case triage has a local cache (zero requests on a hit); the patrol has none.
8. **An occasional upstream 5xx triggers a resume (capped at 2)**, and the UI shows "an upstream failure
   occurred once, resumed with progress"; beyond the cap it degrades to the rule path.
9. **The UI and prompts are currently in Simplified Chinese**; this is a pure front-end app with no external API
   surface. An English UI is an explicit follow-up.
10. **No connection to any real production cluster**: the cases are constructed and the nodes are simulated.
    The real Tencent Cloud / Alibaba Cloud / Baidu Cloud / ZhiXingYun clusters have no network path to Google
    Cloud and are unreachable by design. Only the methodology was transferred, not the data.

These limitations will be raised during technical review; this document lists them as known boundaries rather
than avoiding them.

## 13. Upgrade path

| Horizon | Action | What blocks it |
|---|---|---|
| Near term | Wire a monitoring webhook so failed jobs are fed into triage automatically | needs a resident backend and production credentials; this app is a static site |
| Near term | Replace `inspect_node`'s simulated source with real DCGM / `nvidia-smi` exports | needs a production-side collector and credentials |
| Near term | Connect the notification channel to Feishu / WeCom / email | the `notifications` schema is already shaped for this |
| Mid term | **Unnecessary-RMA dashboard**: "N needless RMAs avoided this quarter" | needs historical data flowing back. **The most direct page for translating technical value into money and cluster capacity** |
| Mid term | Swap the `EFFECTS` table for a real scheduler API (K8s / Slurm) | needs a canary on a non-production cluster first |
| Mid term | Replace Firestore with Auth-based security rules and enforce App Check | needs a login flow; currently anonymous rules |
| Long term | Cluster-level root-cause clustering: 100 failed jobs reduced to 5 root causes | needs an aggregation layer and job metadata |
