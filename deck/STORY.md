# Training Failure Triage deck narrative

The 15-page submission explains how the browser application assesses training failures and controls proposed actions on a simulated GPU cluster. It addresses AI Builder Cup 2026 JAPAC technical reviewers.

## Chapters

| Chapter | Title | Pages |
| --- | --- | --- |
| 1 | The problem | 3-5 |
| 2 | Application workflow | 6-10 |
| 3 | Evidence and limits | 11-15 |

The cover and overview precede the three chapters. Existing section pages remain at 3, 6 and 11. The deck retains its supplied layout sequence and page count.

## Slide content

| Page | Title | Content |
| --- | --- | --- |
| 1 | Training Failure Triage | Software versus hardware diagnosis with evidence and action risk controls. The background 11/14 refers to the joint rule score. |
| 2 | Submission overview | The Xid contrast, application workflow and benchmark scope. |
| 3 | The problem | Unnecessary repair removes capacity. Missed deterioration can cause repeated failures. |
| 4 | Xid 94 escalation errors | A contained memory error needs severity history before an RMA assessment. |
| 5 | Xid 94 frequency and ECC trends | lyg2103 has one event and correctable ECC 1 with a flat trend. lyg2112 has 53 events and correctable ECC 118 with a rising trend. The second case supports an RMA recommendation. |
| 6 | Application workflow | A human starts a patrol. The historical demo patrol made 17 tool calls. Each model attempt permits up to 12 turns and fallback carries completed calls forward. |
| 7 | Cluster inspection | Six constructed seed nodes, four with anomaly signals, and no pasted log input for patrol. The English screenshot uses local seed replay. |
| 8 | Action verification | The earlier recorded run verified two cordons, setting lyg2112 and lyg2115 cordoned from false to true. The English screenshot replays those two events locally. |
| 9 | Action risk and approval | 14 actions comprise 6 low, 5 medium and 3 high risk. The library supplies risk. Automatic execution allows only low risk. The discouraged timeout action is excluded. |
| 10 | Triage tool trace | Four replayed calls for case-xid94-rising, with hardware/RMA recommendation and fixture confidence 0.95. The screenshot shows the application rendering English arguments and reference IDs. |
| 11 | Evidence and limits | The joint F8 rule score is 11/14. Constructed cases do not establish production accuracy. There is no aggregate AI score. |
| 12 | Rule benchmark results | 11/14 (78.6%) joint F8, classification 11/14, RMA 12/14. All 14 cases appear in the table and AI results show Not run. |
| 13 | Application architecture | Knowledge, local pre-analysis, mode-specific tools, model attempts and risk-gated execution. Prompt instructions and code checks have distinct responsibilities. |
| 14 | Evidence support and REA | Snapshot and live tiers are implemented. The artifact tier has no producer and requests raise an error. REA remains a future option for a non-browser deployment. |
| 15 | Demo and verification | Demo URL and verification scripts. Pipeline and browser counts retain their measured context. |

## Measured claims and limits

The rule baseline uses the same scoring path in the browser and `scripts/verify_triage.mjs`. It misses `case-xid48-dbe`, `case-xid94-rising` and `case-gpu-hang-deadlock`. F8 requires both classification and `should_rma` to match the expected result.

The knowledge base contains 24 Xid entries, 27 failure signatures and 6 diagnostic principles. The app registers 10 tools, exposes 6 for case triage and all 10 for patrol. The recorded 17-call patrol and earlier 31/31 browser check describe individual runs. The offline pipeline check reports 81/81. They do not guarantee latency, cost or future model behavior.

The cluster contains simulated data and has no production-cluster connection. Patrol starts with a human click. Tickets remain drafts until operator submission. Notifications remain queued without an external delivery integration. Medium and high risk actions require human approval.

REA is not included in this build. The browser application produces snapshot and live evidence only. A future CLI or server deployment could evaluate rea-agents for local artifact inspection.

## Screenshot provenance

The English refresh captures the actual browser application locally. It intercepts external requests with deterministic local response fixtures. `clean` contains the unmodified seed and no operation records. `shift` contains two cordon records and an English triage replay. The capture makes no live model request or external state change. The replay demonstrates current English UI rendering, not a new model accuracy measurement.

All screenshot crops use geometry collected in their capture session. The deck retains real rendered screenshots and the existing crop pipeline. Slide 5 identifies the two omitted intervening rows so it does not imply adjacency in the source list.
