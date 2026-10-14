# Architecture

**Language:** 🇬🇧 English ｜ [🇨🇳 中文](architecture.md)

## 1. Problem definition

The most common form of waste in a multi-cloud GPU cluster is not "a card failed" — it is a **mismatch between what is reserved and what is used**:

| Pattern | Symptom | Can existing monitoring detect it? |
|---|---|---|
| Over-reservation | 8 cards requested, only 4 actually running; the other 4 hold their slot for the entire period | Yes — but nobody looks at it daily |
| Chronic idling | Cards are allocated, average utilisation < 5% | Yes — but without context |
| Inefficient running | Utilisation between 5% and 30%, never converging | Hard — requires cross-period comparison |

Conventional monitoring answers "what is the utilisation right now". It does not answer **"what does this waste cost, which item should be fixed first, and how much would fixing it save?"** That missing step is what this project provides.

## 2. Data flow

```
Monitoring export (cloud / node / GPU model / reserved cards / used cards / hours / avg utilisation / start hour)
        │
        ▼
┌────────────────────────────────┐
│  analyzer.py  pure compute     │  wasted GPU-hours → energy → cost → carbon, plus pattern classification
│  no network, no AI dependency  │  ← independently unit-tested, reproducible
└────────────────────────────────┘
        │  structured audit result (summary + findings + records)
        ▼
┌────────────────────────────────┐
│  carbon.py  intensity model    │  24-point hourly grid carbon curve → "when to run for least carbon"
│  pure functions, no side effect│  ← identical energy and cost; carbon falls purely by shifting the hour
└────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│  ai.py  decision layer (tool-calling loop)               │
│                                                          │
│   model ──functionCall──▶ tools.py                       │
│     ▲                        │                           │
│     └──functionResponse──────┘                           │
│          (up to 8 turns, see MAX_TOOL_TURNS)             │
│                                                          │
│  tools: query_metrics / estimate_carbon /                │
│         simulate_defer / propose_action                  │
│  no key or call failure → offline rule template          │
└──────────────────────────────────────────────────────────┘
        │
        ▼
  Flask Web (Cloud Run) → metric cards + carbon curve + tool trace + decision list
```

**Layering principle**: every number is computed deterministically by `analyzer.py` / `carbon.py`; the AI is responsible only for **fetching data, reasoning, and registering recommendations**. Four consequences:

1. Numbers are reproducible and auditable — the AI can never "invent a figure";
2. With no API key and no network the system still demonstrates end to end (degrading to the offline template, which produces structured recommendations just the same);
3. Under technical review we can state precisely which part is model capability and which part is engineering determinism;
4. Every number the model cites is traceable to the return value of a specific tool call — the UI displays the call trace so this can be verified live.

## 2.1 The tool-calling loop (why this is a Gen AI implementation, not a wrapper)

`ai.py::_agentic_diagnose` implements a full function-calling round trip:

```
contents = [user prompt]
loop (at most MAX_TOOL_TURNS = 8 times):
    resp = Gemini(contents, tools=[4 functionDeclarations])
    if resp contains functionCall:
        contents += [model turn]
        contents += [tool execution results]   # dispatch_tool runs locally, pure compute, no side effects
        continue
    if resp contains text: return text + accumulated actions / tool_calls
```

| Tool | Input | Output | Why it must come from a tool |
|---|---|---|---|
| `query_metrics` | `cloud?` / `pattern?` / `limit?` | Node detail sorted by cost descending | Prevents the model from "recalling" numbers |
| `estimate_carbon` | `energy_kwh` / `hour` / `region?` | Carbon intensity, emissions, best hour of day | The intensity curve is an external model the LLM has no access to |
| `simulate_defer` | `node` / `to_hour?` | Carbon saved, percentage saved, before/after intensity | Must be combined with the real energy figure from `analyzer` |
| `propose_action` | `title` / `detail` / benefit / effort | Registers reference `A1`, `A2`, … | Recommendations must be structured to render as decision buttons |

`dispatch_tool` fault-tolerance contract: an unknown tool name or malformed arguments **returns an error object instead of raising**, so a single bad model call cannot abort the whole diagnosis.

## 3. Calculation basis (every assumption stated explicitly)

Let `requested` = reserved cards, `used` = cards actually carrying work, `H` = hours, `U` = average utilisation (%).

**Wasted GPU-hours**

```
unused card-hours   = max(requested - used, 0) × H
low-efficiency hours = used × H × (1 - U/100)      only when U < 30
wasted GPU-hours    = unused card-hours + low-efficiency hours
```

**Conversion factors**

| Factor | Value | Source / rationale |
|---|---|---|
| Idle power ratio | 0.25 | Industry rule of thumb: an idle GPU draws roughly 20–30% of TDP; midpoint taken |
| Full-load power ratio | 1.00 | At 100% utilisation the full TDP is assumed; linear interpolation in between (`active_power_ratio`) |
| Industrial electricity price | ¥0.70 / kWh (≈ US$0.098) | Configurable; replace with the real tariff |
| Carbon factor | 0.581 kgCO₂e / kWh | National grid average emission factor (base for the hourly/regional multipliers) |
| Low-efficiency threshold | 30% | Below this, classified as "inefficient running" |
| Idle threshold | 5% | Below this, classified as "chronic idling" |
| Annual carbon uptake per tree | 18 kg | Used to express carbon as an intuitive equivalent |

> Workload-side energy is computed as `used × H × TDP × active_power_ratio(U)`, used for the carbon-aware
> scheduling estimate. It measures "how much electricity this machine actually consumed", which is an
> independent quantity from "how much was wasted".

**GPU model parameters** (`analyzer.py: GPU_SPECS`, replaceable from real procurement records)

| Model | TDP (W) | Price per card-hour (¥) |
|---|---|---|
| H800 | 700 | 24.0 |
| H100 | 700 | 28.0 |
| H20 | 400 | 12.0 |
| A100 | 400 | 15.0 |
| V100 | 300 | 8.0 |

> Unrecognised GPU models fall back to `DEFAULT_SPEC` (400 W / ¥15), so dirty input data cannot fail the whole batch.

## 3.1 Hourly carbon-intensity model (`carbon.py`)

**Physical basis**: grid carbon intensity is not a constant. At the midday solar peak a larger share of electricity is low-carbon, so each kilowatt-hour carries the least carbon; during the evening ramp, fossil-fuelled peaking plants push it to its highest. Therefore **the same energy consumption carries different emissions depending on the hour** — this is the foundation of carbon-aware scheduling.

**Model form**:

```
intensity(hour, region) = 0.581 × hourly_factor(hour) × region_factor(region)     unit: kgCO₂e/kWh
```

The hourly factor is a 24-point relative value, mean 1.0 across the day:

| Hour | Factor | Rationale |
|---|---|---|
| 13:00 (best) | 0.82 | Solar generation peak, highest low-carbon share |
| 19:00 (worst) | 1.10 | Evening peak, fossil-fuelled peaking |
| 04:00–06:00 | 0.86–0.87 | Overnight baseload, low variability |
| 09:00 | 1.00 | Close to the daily mean |

Region factors: `north 1.05 / east 1.00 / south 0.85 / southwest 0.55 / default 1.00`
(regions with a higher fossil share score higher; the hydro-rich southwest scores markedly lower).

**Why "shift the hour" is modelled separately from "use less"**: eliminating waste (using less) and shifting the hour (same energy, different time) are two independent decarbonisation paths. The former saves money *and* carbon; the latter saves no money but still reduces carbon, and it is **non-invasive to production** — no jobs need to be cancelled, only the scheduling window changed. Measured output on the sample dataset: the highest-consumption node runs at 20:00; moving it to 13:00 reduces carbon by 54.7 kgCO₂e (≈25%) with energy and cost both unchanged.

> ⚠️ **An honest boundary**: the curve and the regional factors are **simplified approximations based on public
> information, not measured data**. Using them as a real scheduling basis requires ingesting a live intensity
> feed such as Electricity Maps; `carbon.py` is designed so that the data source can be swapped without
> touching `ai.py` or the UI. In addition, only jobs with checkpoint-and-resume capability can genuinely be
> postponed — we list deferrability as missing data rather than assuming every job can be shifted.

## 4. Known limitations

1. **Energy is approximated as TDP × idle ratio**, not measured. Precision requires ingesting DCGM / IPMI power readings.
2. **Utilisation is averaged over the period**, masking distributions such as "fully loaded for the first 80% of the window, idle for the last 20%".
3. **No per-job attribution** — we know which node wastes, not which job caused it. This can be upgraded once job-queue and card-allocation data are joined in.
4. **Electricity price is a constant**; real bills are non-linear and tiered.
5. **The hourly carbon curve and regional factors are simplified approximations, not measured** (see the boundary note in §3.1).
6. **Load deferrability is unverified**: carbon-aware scheduling presupposes that jobs can be postponed. We perform no deferrability classification, so the recommendations are labelled "requires human confirmation" in both the UI and the docs.

## 5. Upgrade path

| Horizon | Action |
|---|---|
| Near term | Ingest real monitoring exports (Prometheus / cloud APIs), replacing the sample data |
| Near term | Ingest measured DCGM power readings, replacing the idle-power ratio with a measured curve |
| Near term | Integrate Electricity Maps live carbon intensity, replacing the approximate hourly curve (interface unchanged) |
| Mid term | Add a job dimension for per-job attribution and deferrability classification |
| Mid term | Migrate to Vertex AI + Gemini, using managed deployment and IAM authentication instead of an API key |
| Long term | Move from post-hoc audit to prediction: estimate waste risk at quota-approval time |
