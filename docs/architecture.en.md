# Architecture

Language: English | [简体中文](architecture.md) | [Project overview](../README.md) | [中文 README](../README.zh-CN.md)

Training Failure Triage combines deterministic diagnostics with model-driven evidence gathering. Its output is a failure classification, a `should_rma` decision, evidence citations, and proposed remediation. The deployed application uses constructed cases and a simulated cluster.

## Components and data flow

```text
Case snapshot or Firestore simulated-cluster state
  -> deterministic pre-analysis and knowledge lookups
  -> mode-specific tools and Gemini tool-calling loop
  -> classification, RMA recommendation, citations, and action plan
  -> risk check -> permitted simulated action -> verification -> operation log
```

| Component | Role |
|---|---|
| [kb.js](../firebase/public/js/kb.js) | 24 sourced Xid entries, 27 failure signatures, 6 diagnostic principles, version matrices, and GPU memory specifications |
| [triage.js](../firebase/public/js/triage.js) | Xid extraction, signature matching, compatibility checks, memory estimates, and the rule baseline |
| [tools.js](../firebase/public/js/tools.js) | Tool schemas, parameter allow-lists, citations, mode selection, and action-risk enforcement |
| [prompt.js](../firebase/public/js/prompt.js) | English diagnostic instructions and rules matched to the available tools |
| [ai.js](../firebase/public/js/ai.js) | Gemini requests through Firebase AI Logic, tool execution, model fallback, progress resume, and offline fallback |
| [actions.js](../firebase/public/js/actions.js) | 14 remediation actions, approval requirements, commands, rollback, and execution-package generation |
| [cluster.js](../firebase/public/js/cluster.js) | Firestore access and verified changes to the six simulated nodes |
| [app.js](../firebase/public/js/app.js) | Case triage, On-call patrol, Benchmark, and Action library and approvals |

The site is served from Firebase Hosting without a build step. Cases are loaded from [cases.json](../firebase/public/data/cases.json); the simulated cluster starts from [cluster_seed.json](../firebase/public/data/cluster_seed.json).

## Modes and tools

The mode determines the available tools: **6 for case triage and 10 for patrol**. Case triage uses a case evidence pack. Patrol can also read and change the simulated cluster.

| Tool | Available in | Purpose |
|---|---|---|
| `search_failure_signature` | Both | Return matching failure signatures and diagnostic candidates |
| `lookup_xid` | Both | Return sourced Xid meaning and conditional handling |
| `check_compat` | Both | Check driver, CUDA, PyTorch, and NCCL compatibility |
| `estimate_memory` | Both | Estimate training memory requirements |
| `inspect_node` | Both | Read case telemetry or current simulated-node telemetry |
| `propose_fix` | Both | Register an action from the library with its assigned risk |
| `scan_cluster` | Patrol | List simulated nodes and flag symptoms for inspection |
| `execute_action` | Patrol | Apply permitted low-risk actions to simulated state |
| `draft_ticket` | Patrol | Create a ticket draft for human review |
| `notify_operator` | Patrol | Add an item to the Firestore notification queue |

`TOOL_PARAMS` limits the arguments passed into tool implementations. Each evidence-bearing tool call receives a citation ID such as `T1`; the UI displays arguments and results alongside the report. Knowledge-base class hints are inputs to diagnosis rather than final classifications.

## Model loop and fallback

The request includes English instructions, the evidence pack, and the tool declarations for the selected mode. Model turns are retained as returned, including any `thoughtSignature`. Function results are sent back using the role accepted by the Firebase AI Logic endpoint.

Each tool loop allows 12 model turns. A turn may contain several tool calls. A resume carries completed tool calls and conversation state forward; resumes are capped at 2. Final results preserve the accumulated trace.

The configured model order is `gemini-3.5-flash-lite`, `gemini-3.5-flash`, `gemini-3.1-flash-lite`, and `gemini-3.8-flash`. Short rate limits can retry the current model; daily quota exhaustion advances to another model. Availability depends on the upstream service and project quota. When online attempts are exhausted, the application returns a labelled offline rule result.

These request limits do not imply a fixed number of calls, elapsed time, or successful actions per patrol.

## Evidence boundary

| Evidence tier | Producer in this build |
|---|---|
| `snapshot` | Telemetry frozen inside a constructed case, used for reproduction and benchmarking |
| `live` | Current state read from the simulated Firestore cluster |
| `artifact` | Unimplemented; requesting this tier throws |

REA is not included in this build. The browser application produces snapshot and live evidence only. A future CLI or server deployment could evaluate rea-agents for local artifact inspection.

Tier order describes the relationship to the evidence source, not a confidence score. A live read is current simulated state. It does not establish a fact about a production node. Results with no evidence omit the tier.

## Actions, approval, and state verification

The action library contains **14 actions: 6 low, 5 medium, and 3 high risk**. Risk is assigned by code and cannot be supplied by the model.

| Risk | Human review in the action library | Automatic patrol execution |
|---|---|---|
| Low, 6 actions | Bulk approval is available | Permitted on simulated state |
| Medium, 5 actions | Per-item approval and acknowledgement of impact | Refused |
| High, 3 actions | Per-item approval, change-ticket number, approver, and confirmation | Refused |

`raise_nccl_timeout` is marked discouraged and excluded from the model's candidate list. An action must include rollback information to enter an execution package.

For a permitted simulated action, `cluster.js` reads the node, computes the field update, writes the change, checks the resulting state, and records verification. Cordon sets `cordoned: true` and `schedulable: false` while retaining running jobs. Operation records distinguish verified, unverified, and failed outcomes. Repeated actions are handled idempotently.

| Firestore collection | Stored data |
|---|---|
| `cluster` | Six simulated nodes, job state, and telemetry |
| `events` | Operation records with the persisted operation outcome and verification metadata |
| `tickets` | Draft tickets awaiting human review |
| `notifications` | Queued notification items |

An RMA draft is not a submitted repair request. Approval records and exported commands do not connect this build to a production scheduler. Notifications are queued without IM or email delivery.

## F8 benchmark

F8 compares classification and `should_rma` with expected labels across 14 constructed cases. The rule baseline gets both fields correct on **11/14 (78.6%)**. Classification alone is 11/14; RMA decisions alone are 12/14.

| Case | Expected | Rule result | Diagnostic distinction |
|---|---|---|---|
| `case-xid48-dbe` | Hardware, RMA | Application | Distinguish the earlier double-bit error from secondary Xid 45 |
| `case-xid94-rising` | Hardware, RMA | Hardware watch | Read the 30-day frequency and ECC trend |
| `case-gpu-hang-deadlock` | Application, no RMA | Network | Inspect kernel logs and process state |

The library has 4 RMA cases and 10 non-RMA cases. Its three contrast pairs cover Xid 94, a missing driver, and a GPU hang. The case set is small and constructed, so its result is not a production accuracy estimate. AI aggregate results remain unset until all 14 cases complete.

## Verification and operation

```bash
node scripts/verify_triage.mjs
node scripts/verify_pipeline.mjs
node scripts/verify_submission.mjs --prepublish
node scripts/verify_submission.mjs
```

The triage verifier checks diagnostic and action invariants and reproduces F8. The pipeline verifier uses stubbed fetch and an in-memory cluster, so both run offline. The submission verifier checks documentation, English output, and deliverable requirements. Prepublish mode permits the pending public video; strict mode requires its concrete Google Drive viewer/share URL.

The Chrome acceptance script, `scripts/browser_check.mjs`, makes model requests and reads/writes the shared simulated Firestore state. It requires a separately intended acceptance run.

See [the README](../README.md) for local serving and deployment, and [the demo script](demo-script.en.md) for the walkthrough.

## Deployment limits

The browser patrol starts with a human click. Continuous monitoring needs a resident service and scheduler. Production use also needs a telemetry collector, scheduler integration, authenticated Firestore rules, App Check enforcement, and notification delivery.

The demo allows anonymous access to `cluster`, `events`, `tickets`, and `notifications`; other paths are denied. Its Firebase web configuration is public. Do not place production credentials or private telemetry in this demo.

Knowledge coverage is limited to the entries listed above. Generic remediation commands need platform adaptation, and diagnosis needs human review. A production AI accuracy score and unattended production operation have not been established.
