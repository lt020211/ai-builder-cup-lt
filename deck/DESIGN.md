# Training Failure Triage deck design

This refresh preserves the supplied 15-page design and the repository's `.slide` authoring pipeline. The audience is the AI Builder Cup 2026 JAPAC technical review panel.

## Canvas and repeated elements

The authoring canvas is 1280 x 720. Final slide renders are 1920 x 1080.

| Region | Position | Design |
| --- | --- | --- |
| Title | y 18-110, x 72-1208 | 34px bold title, optional 14px evidence label on the right |
| Content | y 110-654 | Existing screenshots, comparison diagrams and text |
| Footer | y 654-702 | 14px project attribution or source note, page number at right |

Pages 1, 3, 6, 11 and 15 retain the full dark canvas with a subtle grid. Pages 3, 6, 11 and 15 retain their minimal bottom-right page number. The remaining pages use the existing white content layout and 72px side margins.

## Color and typography

| Role | Value |
| --- | --- |
| Ink and dark background | `#0B1220` |
| Blue | `#2F6BFF` |
| Red | `#E5484D` |
| Green | `#16B981` |
| Light panel | `#F1F4FA` |
| Body | `#1A2434` |
| Secondary text | `#64748B` |

The dark background keeps the original gradient through `#131E33`. Existing risk indicators also retain amber. Red indicates repair/escalation or risk. Green indicates monitoring without RMA or a successful verification result.

The source font stacks remain `Inter, "Helvetica Neue", Arial, sans-serif` for prose and `"JetBrains Mono", "SF Mono", Menlo, monospace` for data and code. The existing rendered export uses its available font fallback. Main content titles stay at 34px, section titles at 64px and the cover at 76px. Large data remains 104px or larger. Body copy uses the template's 14-20px sizes.

## Visual evidence

Screenshots come from the actual English application rendered in Chrome. No UI illustration or drawn replacement substitutes for the screenshots. Captures use a 1440 x 900 CSS viewport at device scale 2. Their full document height varies by tab.

The refresh uses a local response replay because the deployed application shares mutable simulated Firestore state. `clean` replays the unmodified six-node seed with no events. `shift` replays two cordon outcomes and an English triage fixture. No live Gemini call, Firestore reset, or external write occurs during capture. Captions identify this mode. Historical measurements retain their original run context.

Each group's `boxes.json` records element bounds during the same session as its screenshots. `make_crops.py` reads those bounds and each slide's image dimensions. It expands the crop to the required ratio without removing evidence and exports at twice the image frame size.

| Asset | Source | Slide |
| --- | --- | --- |
| `crop-node-lyg2103.png` | clean patrol row 2 | 5 |
| `crop-node-lyg2112.png` | clean patrol row 5 | 5 |
| `crop-cluster-card.png` | clean patrol cluster panel | 7 |
| `crop-oplog.png` | shift patrol operation-log panel | 8 |
| `crop-risks.png` | clean actions risk panel | 9 |
| `crop-tooltrace.png` | shift triage tool trace | 10 |
| `crop-bench-table.png` | clean benchmark, all 14 rows | 12 |

Slide 5 retains separate node-row crops and names the two intervening rows omitted from the original list. Screenshots keep their aspect ratio and original UI colors.

## Page layouts

| Page | Subject | Preserved layout |
| --- | --- | --- |
| 1 | Training Failure Triage | Dark cover, grid and large 11/14 |
| 2 | Submission overview | Intro at left, three chapter rows at right |
| 3 | The problem | Dark section page, large 94 |
| 4 | Xid 94 escalation errors | Asymmetric comparison diagram and explanation |
| 5 | Xid 94 frequency and ECC trends | Large counts above two full-width node crops |
| 6 | Application workflow | Dark section page, historical 17-call measurement |
| 7 | Cluster inspection | Cluster screenshot at left, three readings at right |
| 8 | Action verification | Operation-log screenshot above the 2/2 result |
| 9 | Action risk and approval | Risk rows and code gate above the UI crop |
| 10 | Triage tool trace | Recommendation summary, full trace and explanation |
| 11 | Evidence and limits | Dark section page, large 11/14 |
| 12 | Rule benchmark results | Large score and misses at left, full table at right |
| 13 | Application architecture | Five vertical layers and responsibilities at right |
| 14 | Evidence support and REA | Three evidence rows above two explanatory columns |
| 15 | Demo and verification | Dark centered close with demo and script references |

## Content rules

Titles name the subject. Copy uses concise English without slogans, em dashes, semicolons, dot separators, vertical bars, personification or unsupported guarantees. Keep exact tool names, fields and case IDs.

F8 is the joint classification/RMA score of 11/14 (78.6%) on 14 constructed cases. Classification alone is 11/14 and RMA alone is 12/14. The deck does not report an aggregate AI score or claim production accuracy.

Slide 14 preserves the disabled `artifact` row in neutral gray and states the deployment boundary explicitly:

REA is not included in this build. The browser application produces snapshot and live evidence only. A future CLI or server deployment could evaluate rea-agents for local artifact inspection.

## Generation and review

Use the existing capture, crop, slidep and PDF scripts. Keep sources editable. Build candidate exports in a private directory before copying validated artifacts to `deck/Training-Failure-Triage.pptx` and `docs/Training-Failure-Triage-deck.pdf`.

Review all 15 individual 1920 x 1080 slide renders against the supplied design. Check text fit, screenshot legibility, metric labels and the unsupported artifact tier. Render the final PDF with Poppler and verify all 15 pages.
