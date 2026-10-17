# English Submission Refresh Design

## Goal

Make the repository and deployed demo ready for an international judging panel: English is the default language, the product copy reads like an operations tool rather than a generated pitch, team ownership is explicit, the final demo video has a public Google Drive URL, and REA is described accurately as a future option rather than a shipped dependency.

## Scope

The refresh covers the complete submission path:

- default repository documentation;
- all user-visible browser UI and generated execution packages;
- prompts and model-facing tool descriptions that determine response language;
- core implementation comments and local scripts visible to code reviewers;
- automated checks and recording selectors affected by copy changes;
- screenshots, deck exports, and the final demo video;
- Firebase Hosting deployment and the public Google Drive video link.

Stable machine interfaces remain unchanged: function names, action IDs, classification IDs, Firestore field names, DOM IDs, `data-tab` values, case IDs, and citation IDs.

Chinese source material remains only where it is deliberately localized or part of bilingual output, such as `README.zh-CN.md`, Chinese reference documents, and the Chinese subtitle track. Default submission artifacts and executable source comments use English.

## Product Voice

Copy uses concise operational language. It states the observation, decision, action, and boundary without arguing with the reader.

Remove or reduce:

- star markers, repeated emoji, and excessive bold emphasis;
- rhetorical contrasts such as "not a wrapper" or "this is real";
- repeated claims about honesty, credibility, or what judges may ask;
- personification of the agent;
- repeated uses of "actually", "never", "prove", and "cannot invent".

Prefer factual wording such as:

- `Tool trace` instead of `AI's tool-call trace`;
- `Numeric findings are linked to deterministic tool outputs.`;
- `Actions update the simulated Firestore cluster and are verified by a read-back.`;
- `The included benchmark reproduces an 11/14 rule-baseline score.`

The core question, "Is this a software issue, or should the GPU be replaced?", appears once in the primary introduction and is not repeated as a slogan.

## Repository Documentation

`README.md` becomes the concise English default. The current Chinese README moves to `README.zh-CN.md`. The existing English README is consolidated into the new default rather than retained as a second long English source.

The default README keeps these sections:

1. problem and intended users;
2. live demo and public video;
3. team;
4. product workflow and architecture;
5. reproducible benchmark;
6. safety and deployment boundaries;
7. local verification and deployment;
8. known limitations.

Long explanations of video production, repeated self-justification, and internal design history move to the existing development documents when they remain useful.

The team section states:

```text
lt020211 - Team Lead and Engineer
```

This documents repository ownership but does not claim that the repository alone proves the competition's team-size or eligibility requirements.

The video section links to both:

- the final public Google Drive viewer URL;
- the repository MP4 as a downloadable mirror.

The final Google Drive URL is inserted only after the regenerated video has been uploaded and its public viewer permission has been verified.

## Browser Application

The entire deployed experience uses English, including:

- navigation, headings, buttons, helper text, empty states, progress states, errors, and approval forms;
- case titles, case explanations, expected outcomes, telemetry notes, and benchmark labels;
- knowledge-base descriptions, diagnostic explanations, action names, impact descriptions, expected output, and rollback text;
- tool descriptions, tool errors, evidence provenance, and offline fallback results;
- ticket drafts, operation log entries, notifications, and downloaded execution packages;
- Gemini prompts and the explicit instruction to answer in English.

Chinese matching tokens used to recognize Chinese input logs may remain as internal data. They are input compatibility, not presentation copy.

`<html lang="en">`, the page title, and metadata are updated. The local result cache key moves from `triage:cache:v2` to `triage:cache:v3` so previous Chinese model output is not reused.

The application gains stable machine-readable state markers for long-running UI actions. Browser acceptance and recording scripts wait on those markers instead of matching translated visible text.

## Evidence Tiers And REA

The submitted build produces two evidence tiers:

- `snapshot`: telemetry frozen in a constructed case;
- `live`: current state read from the simulated Firestore cluster.

`artifact` remains disabled and `evidenceTier('artifact')` continues to throw. Documentation and deck copy state:

> REA is not included in this build. The browser application produces snapshot and live evidence only. A future CLI or server deployment could evaluate `rea-agents` for local artifact inspection.

REA is not added as a dependency, tool, MCP configuration, or claimed capability in this refresh.

## Verification Strategy

Changes follow test-first development.

1. Add a submission verifier that initially fails against the current repository. It checks that the default README is English, `lt020211` is identified as team lead, the deployed document uses `lang="en"`, the public video link uses Google Drive, and the repository MP4 still exists.
2. Extend the triage verifier with evidence-tier invariants: tier order, implemented flags, `snapshot` and `live` production, and rejection of `artifact` and unknown tiers.
3. Add stable DOM state assertions before changing visible UI copy.
4. Update browser and recording checks to use stable IDs and state attributes instead of visible-language selectors.
5. Translate production content and make the new tests pass.
6. Run the offline triage and pipeline suites, browser acceptance, recording dry run, media checks, PDF render verification, and live-site smoke checks.

The rule baseline remains 11/14. Translation must not change classifications, RMA decisions, action risk levels, approval gates, or tool availability by mode.

## Media And Deck

After the English UI is stable:

1. reset the simulated demo cluster only after explicit confirmation, because this clears cloud demo history;
2. capture fresh English screenshots;
3. regenerate deck crops, the editable deck, and the 15-page PDF;
4. record the full live workflow with English narration and bilingual hard subtitles;
5. verify duration is below 180 seconds and resolution remains 1600x900;
6. upload the final MP4 to Google Drive;
7. request explicit confirmation immediately before changing the Drive permission to `Anyone with the link`;
8. add the verified viewer URL to the README and submission verifier.

The deck remains English. Slide 14 keeps evidence-tier boundaries but changes REA wording from a natural producer to an unimplemented future option.

## Deployment

The static site remains on Firebase Hosting under project `gpu-waste-auditor-2026`. No new backend is introduced. Firebase AI Logic and Firestore remain the only managed cloud services used at runtime.

Deployment uses the existing REST-based script. Before deployment, the local and live verification suites must pass. After deployment, the live title, four workspaces, Firestore read path, cache version, tool bundle fingerprint, and console errors are checked again.

## Non-Goals

- Integrating REA or adding raw artifact collection.
- Connecting a production GPU cluster.
- Changing diagnostic logic, benchmark expectations, action risk levels, or approval policy.
- Adding a general-purpose localization framework; English becomes the product language, while Chinese reference documents remain separate files.
- Claiming that README text satisfies registration eligibility or team membership requirements.
