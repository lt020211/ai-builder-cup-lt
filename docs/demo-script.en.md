# Demo script: Training Failure Triage

Language: English | [简体中文](demo-script.md) | [Project overview](../README.md) | [中文 README](../README.zh-CN.md)

[Live demo](https://gpu-waste-auditor-2026.web.app) | [Repository MP4](Training-Failure-Triage-demo.mp4) | [Solution deck](Training-Failure-Triage-deck.pdf), 15 pages

Public Google Drive video: upload pending. The repository MP4 is available; the public-link requirement remains incomplete.

The target runtime is 2:45, below the three-minute limit. The repository video has English narration and bilingual subtitles. Use the current English labels below when demonstrating the browser application.

## Scope

The repository MP4 is a local deterministic replay: scripted model responses drive the real application tools over six simulated nodes. Firestore-format reads and writes stay in an isolated browser profile; no live model request or external storage write occurs. A persistent banner identifies this mode. The walkthrough covers a human-started patrol, evidence gathering, verified low-risk actions, a ticket draft, queued notifications, and the local benchmark.

REA is not included in this build. The browser application produces snapshot and live evidence only. A future CLI or server deployment could evaluate rea-agents for local artifact inspection.

## Preparation

- Serve `firebase/public` on loopback and use the explicit replay command below. The recorder uses a 1600×900 viewport and a fresh isolated Chrome profile.
- The checked-in `scripts/demo_replay.mjs` supplies deterministic transport fixtures. A clean seed has six nodes, four showing anomalies; any reset affects only local replay state.
- Confirm that the On-call patrol panel is visible, node cards have loaded, and the operation log is empty before the recorded patrol.
- A manual live demonstration is a separate workflow: it uses model quota and can reset/write shared simulated Firestore state. Live acceptance remains the explicit Task 9 external gate.

## Walkthrough and narration

| Time | Screen | Narration |
|---|---|---|
| 0:00–0:20 | Landing page | “GPU training failures can look similar while needing different responses. An application bug may leave the hardware usable; repeated errors with rising ECC may require hardware escalation. This demo uses constructed cases and simulated nodes to compare the evidence.” |
| 0:20–0:35 | On-call patrol, then Run patrol | “This local replay uses six simulated nodes. The patrol starts when I click Run patrol. The static browser application has no resident monitoring process.” |
| 0:35–1:05 | Tool-call trace | “Scripted model responses call scan_cluster, then inspect flagged nodes and look up Xid meanings. The trace shows real application tool execution over replay data. Case triage has six tools; patrol has all ten.” |
| 1:05–1:30 | Nodes lyg2103 and lyg2112 | “Both nodes report Xid 94. lyg2103 has one occurrence in 30 days and flat ECC, so the expected response is monitoring without RMA. lyg2112 has 53 occurrences and correctable ECC at 118 with a rising trend, which supports hardware escalation.” |
| 1:30–1:55 | Operation log and simulated node state | “Cordon blocks new jobs while leaving running jobs in place. The application writes simulated state, checks the result, and records verification. Medium- and high-risk actions require human approval.” |
| 1:55–2:15 | Ticket draft and notification queue | “The RMA item is a draft for human review. No repair request has been submitted. Notifications stay queued in local replay state; this build does not deliver them to IM or email.” |
| 2:15–2:35 | Benchmark, Run rule baseline (local) | “On these 14 constructed cases, the F8 rule baseline gets both classification and the RMA decision correct on 11 out of 14. The misses involve secondary events, a rising error trend, and a code deadlock. This score is reproducible locally.” |
| 2:35–2:45 | Report and closing frame | “The output combines a classification, an RMA recommendation, evidence citations, and an action plan. Production use would require telemetry and scheduler integrations, access controls, and human review.” |

The raw JSON view is a local projection in Firestore REST document format, labelled as replay. It does not navigate to Firestore. Read the verification result actually displayed, including any failure. The exact 21-beat narration and bilingual captions are generated from `BEATS` in `scripts/record_demo.mjs`; the table is a presentation outline.

The repository replay contains 17 patrol tool calls, 2 verified cordons, 1 draft ticket, and 3 queued notifications. These are observations from the deterministic recording, not live model acceptance. A separate historical live run used 16 tool calls, 2 verified cordons, 1 draft ticket and 1 queued notification, and took 41.2 seconds. Live model outcomes can vary.

## Action and evidence notes

The library contains 14 actions with a **6 low / 5 medium / 3 high** risk split. The library assigns risk; the model selects action IDs. Automatic actions are limited to low-risk changes to the simulated cluster. Exported execution packages require manual review and use.

The knowledge base contains 24 Xid entries, 27 failure signatures, and 6 diagnostic principles. The benchmark evaluates a constructed case library, not production accuracy. An aggregate AI score should be shown only after all 14 cases complete.

## Recording commands

Prerequisites: Node.js with built-in WebSocket support (tested on Node 24), Google Chrome at the path in the recorder, and Python 3. Run this static server from the repository root in one terminal:

```bash
python3 -m http.server 8908 --bind 127.0.0.1 --directory firebase/public
```

In a second terminal, use a new output directory to preserve the verified recording:

```bash
node scripts/record_demo.mjs --mode=replay \
  --url=http://127.0.0.1:8908/ --no-reset --out=shots-demo/replay-new
node scripts/record_demo.mjs --mode=replay --dump-beats --calls=17 \
  --out=shots-demo/replay-new
```

The first command captures the application directly with the checked-in replay transport and saves `timeline.json`, frames, and `replay-audit.json` in `shots-demo/replay-new`. Verify the observed patrol count is 17 before exporting beats with that count. The audit must report zero external attempts, unexpected requests, and transport errors. Replay replaces Firebase/Gemini fetches locally and blocks all other external browser requests before navigation. Missing/unknown/live mode or a non-loopback URL fails before Chrome starts. `--dry` skips both case and patrol model fixtures; its placeholder counts are for checks, not publication.

For offline browser acceptance using the same production assertions:

```bash
node scripts/browser_check.mjs --mode=replay --url=http://127.0.0.1:8908/ \
  --audit=shots-demo/replay-new/browser-audit.json
node --test scripts/verify_demo_contracts.test.mjs
```

To compose a new candidate, install `edge-tts`, `imageio-ffmpeg`, and `Pillow` in your Python environment, then run:

```bash
python3 scripts/demo_voice.py --dir shots-demo/replay-new --fresh \
  --voice en-US-AndrewNeural --out shots-demo/replay-new/voice.m4a
python3 scripts/demo_caption.py --dir shots-demo/replay-new \
  --out shots-demo/replay-new/Training-Failure-Triage-demo.mp4 \
  --voice shots-demo/replay-new/voice.m4a
```

Voice synthesis is a separate network operation through Edge TTS; the recorder and browser acceptance above remain local. `--fresh` prevents stale narration-cache reuse. Review the candidate before replacing the verified repository MP4. Stop the static server with Ctrl-C when finished.

The scripts check panel selection, unresolved call-count captions, held frames, runtime, and audio/video duration alignment. Review the resulting MP4 for readable text, English narration, subtitle timing, and a runtime below 180 seconds.

For audio-only changes, `scripts/demo_caption.py --attach` reuses an existing video track. Caption changes require recomposition. Keep spoken counts aligned with the recording used.

## Publication verification

```bash
node scripts/verify_submission.mjs --prepublish
node scripts/verify_submission.mjs
```

Prepublish mode permits the pending Drive upload while checking the repository MP4 and documentation. Strict mode must fail until a concrete public Google Drive viewer/share URL is present. After upload, verify that the URL opens without a sign-in requirement before marking the public-link requirement complete.
