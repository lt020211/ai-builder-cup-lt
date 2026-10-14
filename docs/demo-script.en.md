# Demo video script — Training Failure Triage (on-call Agent)

**Language:** 🇬🇧 English ｜ [🇨🇳 中文](demo-script.md)

> ⚠️ **Decide the narration language before you record.** This is a JAPAC-regional competition and the
> reviewing panel may not understand Mandarin. This file is the English-narration version; `demo-script.md`
> is the Chinese-narration version and the two storyboards correspond **shot for shot**.

> **The shipped video already implements "English narration text + burned-in bilingual subtitles."**
> The on-screen English lines are `BEATS[].caption` in `scripts/record_demo.mjs`; the Chinese lines are
> `BEATS[].zh`. The narration script in this file is the **full per-shot narration** — longer than the
> hard subtitles (capped at two lines), for voiceover or a spoken walkthrough.

> Official requirement: the demo video must be **under 3 minutes**. This storyboard is laid out for
> **2:45**, leaving 15 seconds of headroom.

## This film is produced by scripts, not edited together

```
node scripts/record_demo.mjs                    # walks the live site per the storyboard → shots-demo/
python3 scripts/demo_voice.py                   # per-shot English narration, fitted → shots-demo/voice.m4a
python3 scripts/demo_caption.py --dir shots-demo \
        --out docs/Training-Failure-Triage-demo.mp4 \
        --voice shots-demo/voice.m4a            # burns captions + progress bar, mixes voice, encodes
```

Splitting it into three makes it **re-runnable**: captions, progress bar and bitrate all live in the compose
step, so changing the words only means re-composing — no re-recording (and re-recording means spending
model quota again). Each subtitle switches at the real start/end time recorded for that shot
(`shots-demo/timeline.json`); nothing is cut or joined, so picture and words line up by construction.

The narration follows the same direction of causality rather than the reverse: **synthesise first, measure
the real duration, and only then choose a speaking rate.** A line that will not fit its shot means the line
is too long, not that it should be read faster. The rate is clamped to **−15% ~ +30%** (`RATE_MIN` /
`RATE_MAX` in `scripts/demo_voice.py`) and every shot that hits the clamp is listed in the log — read those
lines first, then decide whether to cut the words. A few seconds of silence over a wide shot, while the
viewer reads the screen, is the better trade.

> ★ **Do not re-record just because the frames are gone.** `shots-demo/frames/` is a few hundred MB of
> intermediate material and may be cleaned up. Re-recording to swap an audio track or fix one caption
> would be the wrong trade twice over: it spends model quota again, and a new patrol produces different
> real results (call count, which nodes got cordoned) — while the deck and the docs quote that exact set
> of numbers. One re-record breaks the whole evidence chain. Pick by what you need to change:
>
> **Audio only** (not a single picture pixel moves):
>
> ```
> python3 scripts/demo_caption.py --attach <existing-film.mp4> \
>         --voice shots-demo/voice.m4a --out docs/Training-Failure-Triage-demo.mp4
> ```
>
> The picture track is copied with `-c:v copy` (byte-identical, no generation loss).
>
> **Captions** (the picture does get re-encoded once):
>
> ```
> python3 scripts/rebuild_frames_from_film.py       # crop the caption band off the film to recover the picture
> python3 scripts/demo_caption.py --dir shots-reburn --beats shots-demo/beats.json \
>         --voice shots-demo/voice.m4a --min-band-h 133 \
>         --out docs/Training-Failure-Triage-demo.mp4
> ```
>
> The caption band only covers the bottom 133px, so cropping it recovers all of the screen content —
> **not one pixel of the screen changes; only the overlay we wrote ourselves is replaced.** The cost is
> one extra encode, which is why the script defaults to CRF 16 + preset slow.
>
> `--min-band-h` is not optional: the band has to grow back to whatever you cropped. The new copy usually
> wraps shorter than the old one (133px → 103px here), and without this flag a 30px strip of backing colour
> shows between the content and the blue line.

The recorder also refuses to ship five kinds of defect:

| What it blocks | Why | Threshold |
|---|---|---|
| A caption still holding an unfilled `{calls}` | The call count must come from the screen, never be asserted by the caption | hard error |
| Long frozen stretches (picture held still) | They *look* like "it is thinking"; nothing is moving | > 4s: refuse to encode |
| Total runtime over 180s | Over the limit is non-compliant, not "close" | > 180s: refuse to encode |
| Flattened runtime not matching real runtime | Flattening variable-rate frames to a fixed rate **per frame** accumulates rounding error in one direction — the video track ends up 2s shorter than the voice-over, `-shortest` cuts the last line of narration whole, and nothing is reported | > 1s: refuse to encode |
| Wrong panel in frame before recording | One whole take was recorded on the "single-case" tab and the log showed nothing wrong | hard error |

> ★ Before recording, the script prints `镜头对着：tab-patrol　当前标签：值班 Agent`.
> **Read that line with your own eyes** — if the panel is wrong, every shot after it is wrong.

---

## The one thing this video has to prove

Just one: **it ran an entire on-call shift end to end, and "end to end" is real.**

Compared with last year's overall winner, SalesShortcut (find customers → research needs → generate a
proposal → sales outreach), our four steps are: **discover proactively → gather evidence proactively →
triage into a plan → act automatically + push outreach + verify**.

Read it as a four-step demo where every step has to land:

| Step | What the viewer must see |
|---|---|
| ① Proactive discovery | Nobody pasted a log. One click and the Agent goes and looks at the cluster itself |
| ② Proactive evidence gathering | The tool-call trace: what it called, with which arguments |
| ③ Triage into a plan | The same error code on two nodes yields **opposite conclusions** |
| ④ Act + outreach + verify | "Verification passed" in the operation log; the ticket draft; the notification queue |
| ⑤ Why a model is required | The rule baseline is 11/14, and its three wrong answers each map to one diagnostic principle |

**Three shots that must be in frame** (miss them and the technical score is gone):
1. **The tool-call trace** (not "the AI wrote a paragraph")
2. **"Verification passed" in the operation log** (proof that execution is real, not a UI animation)
3. **The 11 / 14 on the benchmark page** (a comparison that can be reproduced)

---

## Pre-recording checklist

**Finish this section before you press record.** Problems on the day cost far more than the preparation does.

### Environment
- [ ] The page is deployed to Firebase Hosting and you have a publicly reachable URL
- [ ] headless Chrome runs locally (the script launches its own with `--headless=new`; you do not open a browser)
- [ ] No browser zoom, no bookmark-bar hiding, no Do Not Disturb — the frame is locked to **1600×900** by the script

### State (**the script does all of this itself, and fails loudly at every step**)
- [ ] Click "**reset simulated cluster**" → wait for the operation log to be genuinely empty
      (careful: do not count `#events li` — with zero events that list holds one *placeholder* `li`;
      count only real events, which carry the `ok` / `fail` / `info` class)
- [ ] Switch to the on-call tab → wait for node cards to render
      (careful: you must click `#tabs button[data-tab="patrol"]`; `#tab-patrol` is the panel div and
      clicking it does nothing at all)
- [ ] The cluster state shows **"6 nodes, 4 of them showing anomalies"** (if it is not 4, the seed data was
      modified — click reset)
- [ ] It prints "镜头对着：tab-patrol" — **confirm that line yourself**

> None of those "careful" notes are theoretical: every one of them is a trap that was actually hit, and each
> one let a take **look perfectly healthy while being wrong**. They are hard assertions in the script now,
> rather than a box to tick on a checklist.

### Quota (★ read this section carefully — this is where recordings fail)
- [ ] The on-call patrol **has no cache** (it genuinely runs every time). So do **one dry run of the patrol**
      before recording to confirm there is enough quota
- [ ] **One patrol consumes about 12–16 model requests** (derived from tool rounds: one request per round;
      slightly fewer when the model emits calls in parallel. A resume triggered by the turn cap adds
      another batch — see `MAX_RESUMES` in `ai.js`)
- [ ] The free tier is metered **per model, per day** — measured at about **20 requests/model/day**
  → in practice that is **roughly 5–6 patrols per day**. If you have already debugged several rounds today,
      check the remaining quota before recording
- [ ] This cut records **the on-call patrol only**: the single-case triage page is not in the storyboard, so
      its cache does not need warming (that matters only for the manual walkthrough — see the quota section
      of the README)
- [ ] The benchmark tab clicks "run rule baseline" — **computed locally, zero requests**
- [ ] If the dry run shows "answered directly by gemini-…, no tools were called this time" or a degradation
      notice, quota or the upstream is in trouble — **do not start recording**
- [ ] Note how long one full patrol takes: **15–40 s** when things go well; **90–120 s** if an upstream 500
      triggers a resume (the resume preserves completed actions, so nothing is wasted, but it is slower — the
      page shows "an upstream failure occurred once, resumed with progress")
- [ ] ★ The slower the patrol, the less room the later shots have. After the patrol the script prints
      "预计成片 Ns" — **if that number is over 178, record again** rather than trying to fix it by hand

---

## Storyboard

### 0:00–0:20　Problem statement (static on the landing page)

| On screen | Voiceover |
|---|---|
| Landing page, mouse still | "We run multi-cloud GPU training clusters. The most expensive mistake is not a missed alert — it is **getting the direction wrong**: treating an application bug as a hardware fault, so a perfectly good card gets retired and sent for RMA. Or treating hardware degradation as a one-off, and only acting once it has spread." |
| Hold a beat | "Both mistakes **can be triggered by the same error code**. Conventional monitoring tells you what the Xid is. It does not tell you whether to replace the card." |

> Voiceover note: **do not say "the AI is impressive".** Say clearly that the problem is *getting the direction
> right* — that is what technical reviewers care about.

### 0:20–0:35　On-call Agent: nobody pasted a log (switch to the "On-call Agent" tab)

| On screen | Voiceover |
|---|---|
| Click the "On-call Agent" tab; the cluster state card appears | "This is on-call mode. Note one thing: **I have not pasted any log.** The cluster state is read live from Firestore — this is not data hard-coded into the page." |
| Click "start on-call patrol"; the button greys out | "I click once, and from there it runs itself. In a real deployment this would be triggered by Cloud Scheduler — a purely static site has no resident process, and I am not pretending it does." |

> ★ Say the "a human clicks it" limitation out loud. That is far better than having a reviewer find it.

### 0:35–1:05　Proactive discovery + evidence gathering (scroll to "AI tool-call trace")

| On screen | Voiceover |
|---|---|
| Scroll to the tool trace, point at the first few entries | "Step one, it calls `scan_cluster` to sweep the cluster itself instead of waiting for me to tell it where to look. Then it gathers evidence node by node with `inspect_node`." |
| Hover over `inspect_node`'s arguments | "**Every number comes from a tool return value.** The model has no licence to give any count, version or time window from memory — that is written into its hard constraints." |

> Editing: do **not** speed this section up. Let the viewer read the tool names and arguments.

### 1:05–1:30　The same error code, opposite conclusions (scroll to the on-call report / node cards)

| On screen | Voiceover |
|---|---|
| Point at the `lyg2112` and `lyg2103` node cards | "Both of these nodes **reported Xid 94**, but the conclusions are opposite." |
| Point at `lyg2103` | "`lyg2103` fired once, ECC flat → classified `hardware_watch`, **no RMA recommended**. Filing one would mean taking a good card offline for nothing." |
| Point at `lyg2112` | "`lyg2112` accumulated **53** occurrences in 30 days, correctable ECC at **118** and still rising → hardware degradation, **RMA recommended**." |
| Hold a beat | "The discriminator was **never the error code itself**. It is the trend." |

> This is the most valuable 25 seconds of the film. **Same code → opposite conclusions.** A reviewer who has
> genuinely read this rule will instantly be able to tell whether this is a wrapper.

### 1:30–1:55　★ Execution is real (scroll to "Operation log")

| On screen | Voiceover |
|---|---|
| Point at one line of the operation log | "It did not stop at a recommendation. It **acted**: it ran cordon on these two nodes — no new jobs accepted." |
| Point at "verification passed" at the end of the line | "Those words are the point. After executing, it **reads the server-side state back** to confirm the change took effect. If it had not, the line would say 'verification failed' — it does not claim a false success." |
| Open the Firestore REST API response | "This is its simulated cluster backend. The same value, read **straight from Firestore's REST API** — not from our interface. `lyg2112`'s `cordoned` is `true`." |
| Reload the whole page | "Same state after a full reload. This is not a UI animation." |
| Hold a beat | "Why cordon only? Because it is **reversible and interrupts nothing that is already running**. drain evicts people, reboot kills a job someone has been running for a week — those two are medium risk and require a human to approve." |

> This section decides the film. **Do not cut the raw-API shot** — the moment reviewers see the data change
> with their own eyes, "execution is real" is established.
>
> **Why not the Firebase console:** the console needs a human to log in and switch windows, so a script cannot
> drive it — which means the take could not be reproduced. Opening the REST response directly is *stronger*
> evidence anyway: it bypasses all of our own code and is the browser doing a bare read against Google's API.

### 1:55–2:15　Push the outreach, but leave the irreversible click to a human (scroll to "Pending human approval" + "Notification queue")

| On screen | Voiceover |
|---|---|
| Point at the ticket card, read out "draft · awaiting human submission" | "An RMA is irreversible: file one and the cluster is a card short. So it prepares the ticket to the point where **a human only has to click confirm** — evidence, commands and rationale all filled in — but **never submits it for you**." |
| Scroll to the notification queue | "Then it pushes to the on-call engineer: what happened, what it already did, and which step is still waiting on you." |

> What this section is really about is product judgement: **tiered approval is not a limitation, it is a
> design.** Low risk it does itself; high risk it lowers the bar as far as possible but leaves the decision
> with a person.

### 2:15–2:35　Why a model is required (switch to "Benchmark")

| On screen | Voiceover |
|---|---|
| Point at 11 / 14 | "The same case library, two paths. The pure rule path — which is to say 'look up the Xid code in a table', the most common real-world approach — scores **11 out of 14**." |
| Point at the per-case table below | "Its three wrong answers each map onto one diagnostic principle: **read the 30-day trend**, **distinguish secondary events from root causes**, **a symptom is not a root cause**. Those three are exactly what a model does well and a lookup table does not." |
| Click "run rule baseline" | "You can verify this number yourself in the browser — it runs the same code." |

> ★ Volunteer the 11/14 instead of only praising the AI. **A number that can be falsified on the spot is far
> more credible than "the accuracy is high".**

### 2:35–2:40　Close (back to the landing page)

| On screen | Voiceover |
|---|---|
| Landing page, static for 2 seconds | "Training Failure Triage: turning a training-failure scene into a judgement with an evidence chain — and into the one that has **already been acted on**." |

> Do not cut to black at the end; hold a static frame for 2 seconds.
>
> **Honest boundaries**: the shipped video states three limitations in the voiceover rather than patching them
> in with a subtitle — ① the demo cluster is a constructed simulated environment containing no real cluster
> information and connecting to no production cluster; ② the patrol is started by a human clicking, because a
> static site has no resident process and a real deployment should be triggered by Cloud Scheduler; ③
> notifications only land in a queue and are not pushed to IM.
> All three are stated in the README's "security boundaries" and "known limitations" too —
> **what the video says and what the docs say must agree.**

---

## Editing notes

- **Numbers must be real.** Every number spoken must match the screen. One of them — "how many tool calls one
  shift costs" — is filled into the caption by the script from the value displayed on screen (the `{calls}`
  placeholder), so it cannot disagree. Check the rest (53 occurrences / ECC 118 / 11 of 14 / 2 cordons)
  against the page before recording — **do not memorise a script**.
- Do **not** speed up the tool-call trace section.
- **The words "verification passed" must be legible** — freeze that frame for half a second if necessary.
- **Keep** the raw Firestore REST response shot. It is the only way to prove "execution is real".
- No background music over the narration; voice takes priority.
- Subtitles are burned in **bilingual**: the English line is for reviewers, the Chinese line lets you check the
  numbers yourself.
- The narration is a single audio track (`shots-demo/voice.m4a`), assembled by `scripts/demo_voice.py` from one
  clip per shot placed at its real timestamp, and is exactly as long as the video. To change the voice, re-run
  with a different `--voice <edge-tts voice>`; neither the captions nor the picture move. For a human
  voice-over, the same interface works:
  `python3 scripts/demo_caption.py --attach docs/Training-Failure-Triage-demo.mp4 --voice <human.m4a> --out film.mp4`
- Hold a static final frame for 2 seconds.

## Fallback material (only if time allows)

- **Tool sets are trimmed per mode**: single-case triage cannot reach `execute_action` / `draft_ticket` /
  `notify_operator` (it is not connected to a cluster). This shows that the capability boundary is designed,
  not begged for in a prompt.
- **Resume after an upstream 500**: showing "keeping the N completed tool calls, continuing on another model".
  Good resilience evidence, but it requires being there at the right moment — do not re-record just for it.
- **Offline degradation**: when the network or quota fails, the page degrades to the rule path and remains
  fully demonstrable. This proves the system is not a wrapped chatbot but has real engineering fallbacks.

## Trim order if you run over time

1. Cut 0:20–0:35 first (the data-source explanation) and fold it into the previous voiceover
2. Then cut 2:15–2:35 (the benchmark) down to half a sentence: "the rule lookup table is 11/14, and all three
   misses require reading the trend"
3. **Never cut**: 1:05–1:30 (same code, opposite conclusions) and 1:30–1:55 (execution is real)
   — those two carry the score
