# Training Failure Triage

Language: English | [简体中文](README.zh-CN.md)

Google Cloud AI Builder Cup 2026 (JAPAC), Sustainability & Social Impact.

Training Failure Triage helps GPU platform teams distinguish application failures from hardware degradation before taking a card out of service. It combines failure logs, node telemetry, Xid references, version checks, and memory estimates into a classification, an RMA recommendation, and a remediation plan.

## Demo and team

[Open the live demo](https://gpu-waste-auditor-2026.web.app) | [Hosting mirror](https://gpu-waste-auditor-2026.firebaseapp.com)

The demo uses constructed cases and six simulated nodes stored in Cloud Firestore. It has no connection to a production cluster.

Team: lt020211 - Team Lead and Engineer

Repository attribution does not establish registration eligibility; the application record remains authoritative.

| Deliverable | Available artifact |
|---|---|
| Demo video | [Repository MP4](docs/Training-Failure-Triage-demo.mp4), 2:44, English narration and bilingual subtitles |
| Solution deck | [PDF](docs/Training-Failure-Triage-deck.pdf), 15 pages |

Public Google Drive video: [View the published demo](https://drive.google.com/file/d/1TLBOoTTjiNSLVGMKatz1rtORza3oBzMU/view).

## Workflow

| Tab | Workflow |
|---|---|
| Case triage | Select a case, run triage, then review the classification, RMA recommendation, evidence citations, and proposed actions. |
| On-call patrol | Click Run patrol to scan the simulated cluster, inspect flagged nodes, apply permitted low-risk actions, and review the operation log, ticket drafts, and notification queue. |
| Benchmark | Run the local rule baseline or run AI triage across the case library. AI results accumulate as cases complete. |
| Action library and approvals | Review action risk, commands, expected output, rollback, and approval requirements before exporting an execution package. |

The same Xid can have different implications. In the demo data, `lyg2103` has one Xid 94 occurrence in 30 days and flat correctable ECC; `lyg2112` has 53 occurrences and correctable ECC at 118 with a rising trend. The expected recommendations are monitoring without RMA and hardware escalation with RMA, respectively.

## Architecture

The browser runs static JavaScript from Firebase Hosting. Gemini is called through Firebase AI Logic; Cloud Firestore holds simulated cluster state, operation records, ticket drafts, and queued notifications.

| Module | Responsibility |
|---|---|
| `kb.js` and `triage.js` | Sourced knowledge, deterministic pre-analysis, compatibility checks, memory accounting, and the offline rule baseline |
| `tools.js` | 10 tools with argument allow-lists and evidence citations; 6 tools for case triage and 10 for patrol |
| `prompt.js` and `ai.js` | English prompts, tool-calling loop, model fallback, progress resume, and labelled offline output |
| `actions.js` and `cluster.js` | Action risk and approvals; simulated state changes followed by verification and an operation record |
| `app.js` | The four tabs, reports, traces, benchmark, and downloads |

REA is not included in this build. The browser application produces snapshot and live evidence only. A future CLI or server deployment could evaluate rea-agents for local artifact inspection.

See [architecture](docs/architecture.en.md) for the tool list and data flow, and [the demo script](docs/demo-script.en.md) for a walkthrough.

## Benchmark

F8 measures whether both classification and `should_rma` match the expected result on 14 constructed cases. The rule baseline scores **11/14 (78.6%)**: classification alone is 11/14 and the RMA decision alone is 12/14.

| Rule-baseline miss | Relevant evidence |
|---|---|
| `case-xid48-dbe` | Xid 45 is a secondary event; the earlier double-bit error changes the diagnosis. |
| `case-xid94-rising` | Repeated Xid 94 events and rising ECC distinguish degradation from a single occurrence. |
| `case-gpu-hang-deadlock` | Kernel logs and process state distinguish a code deadlock from other hangs. |

Run `node scripts/verify_triage.mjs` or use Run rule baseline (local) in the browser to reproduce the result. This small case library is not a production accuracy estimate. An AI aggregate is shown only after all 14 cases complete; no aggregate AI score is claimed here.

## Safety boundaries

- The action library has **14 actions: 6 low, 5 medium, and 3 high risk**. Risk comes from the library; the model selects an action ID.
- Automatic `execute_action` calls accept only low-risk actions and affect the simulated cluster. Medium- and high-risk actions require human approval; an RMA ticket remains a draft.
- A cordon blocks new jobs while leaving running jobs in place. State is checked after an action, and the operation log records its verification result.
- Notifications remain queued in Firestore. IM/email delivery and a resident scheduler are not included.
- Exported execution packages contain commands for human review and manual use. They do not execute on a target node.
- The demo permits anonymous access to four Firestore collections: `cluster`, `events`, `tickets`, and `notifications`. Production use needs authentication, access controls, and App Check enforcement.

## Run and verify locally

Serve the static files with Python, then open [the local app](http://127.0.0.1:8899/):

```bash
python3 -m http.server 8899 --directory firebase/public
```

With Node.js 18 or later:

```bash
node scripts/verify_triage.mjs
node scripts/verify_pipeline.mjs
node scripts/verify_submission.mjs --prepublish
node scripts/verify_submission.mjs
```

The triage and pipeline checks run offline. The submission verifier checks documentation and English output; prepublish mode permits a pending public video, while strict mode requires the concrete Google Drive viewer/share URL published above.

`node scripts/browser_check.mjs http://127.0.0.1:8899/` runs Chrome acceptance checks. It uses model quota and reads/writes the shared simulated Firestore state.

## Deployment

From an authenticated environment with the required Google Cloud permissions, publish the static directory:

```bash
python3 scripts/fb_deploy.py firebase/public
```

`python3 scripts/fb_firestore_setup.py check` inspects the demo database and rules. The script's `rules`, `seed`, and `verify` commands write security rules, reset the simulated cluster, or perform a read/write probe. Use them only when that change is intended.

## Limitations

The knowledge base covers 24 Xid entries, 27 failure signatures, and 6 diagnostic principles. Cases and telemetry are constructed, and model output still needs human review. Scheduler-specific commands require adaptation for a target platform.

A patrol starts with a human click and has no result cache. Latency and model availability vary with quota and upstream service health; exhausted retries produce a labelled rule fallback. Historical request and patrol counts describe individual runs rather than a guaranteed cost or duration.

[MIT license](LICENSE)
