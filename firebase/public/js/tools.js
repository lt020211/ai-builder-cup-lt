/** Tools return evidence and register catalog actions with citation refs. Case mode exposes six tools; patrol adds cluster scan, execution, draft tickets, and queued notifications. */
import { XID_TABLE, FAILURE_SIGNATURES, CLASSES } from './kb.js';
import {
  checkCompatibility,
  estimateTrainingMemory,
  extractXids,
  matchSignatures,
} from './triage.js';
import { RISK_LEVELS, ACTION_LIST, getAction, selectableActions } from './actions.js';

/** Evidence tiers describe provenance, not trust scores. snapshot and live use constructed demo data; artifact has no producer. REA is not integrated in this browser implementation. Keep provenance text centralized and preserve source as an observation alias. */
export const EVIDENCE_TIERS = {
  snapshot: {
    order: 1,
    key: 'snapshot',
    label: 'Evidence snapshot',
    implemented: true,
    provenance_text:
      'Snapshot telemetry from a constructed case; fields follow common nvidia-smi/DCGM conventions.',
  },
  live: {
    order: 2,
    key: 'live',
    label: 'Live read',
    implemented: true,
    provenance_text:
      'Current simulated-cluster state read from Firestore. Nodes are constructed demonstration data; ' +
      'fields follow common nvidia-smi/DCGM conventions.',
  },
  artifact: {
    order: 3,
    key: 'artifact',
    label: 'Original artifact',
    implemented: false,
    what:
      'Direct access to original node artifacts such as binary metadata, core dumps, or packet captures. ' +
      'No producer is implemented in this version.',
  },
};

/** Reject unknown or unimplemented tiers before any result can claim their provenance. */
export function evidenceTier(key) {
  const tier = EVIDENCE_TIERS[key];
  if (!tier) {
    throw Object.assign(new Error(`Unknown evidence tier: ${key}`), {
      code: 'EVIDENCE_TIER_UNKNOWN',
    });
  }
  if (!tier.implemented) {
    throw Object.assign(new Error(
      `Evidence tier "${tier.label}" has no implemented producer and cannot be assigned. ` +
      `See EVIDENCE_TIERS and the README evidence-tier section.`,
    ), { code: 'EVIDENCE_TIER_UNIMPLEMENTED' });
  }
  return { evidence_tier: tier.key, provenance: tier.provenance_text };
}

export const TOOL_SPECS = [
  {
    name: 'scan_cluster',
    description:
      'Scan the cluster and return nodes requiring attention with machine-extracted signals. ' +
      'Call this first in patrol mode. ' +
      'Signals describe observations; inspect each node before classifying its fault.',
    parameters: {
      type: 'object',
      properties: {
        include_healthy: {
          type: 'boolean',
          description: 'Include healthy nodes (default false).',
        },
      },
    },
  },
  {
    name: 'search_failure_signature',
    description:
      'Search known failure patterns for an error or symptom description. ' +
      'Pass original error text or a short symptom description. ' +
      'Results contain typical causes and checks, not a final diagnosis.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Error or symptom text; leave empty to list available patterns.',
        },
      },
    },
  },
  {
    name: 'lookup_xid',
    description:
      'Look up the source-backed meaning, class, and recovery guidance for an NVIDIA Xid. ' +
      'Look up Xids found in logs or telemetry before drawing a conclusion.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'integer', description: 'Xid code, such as 48, 79, or 94.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'check_compat',
    description:
      'Check driver/CUDA runtime/PyTorch compatibility and return individual findings. ' +
      'Uses evidence environment values when arguments are omitted.',
    parameters: {
      type: 'object',
      properties: {
        driver: { type: 'string', description: 'NVIDIA driver version, such as 535.104.12.' },
        cuda_runtime: { type: 'string', description: 'CUDA runtime version, such as 12.6.' },
        torch: { type: 'string', description: 'PyTorch version, such as 2.6.0+cu126.' },
        nccl: { type: 'string', description: 'NCCL version, such as 2.22.3.' },
      },
    },
  },
  {
    name: 'estimate_memory',
    description:
      'Estimate training memory from model states and an activation range, compare with GPU capacity, ' +
      'and return comfortable/tight/will_oom. Uses evidence training configuration when arguments are omitted.',
    parameters: {
      type: 'object',
      properties: {
        model_params_b: { type: 'number', description: 'Model size in billions of parameters.' },
        precision: { type: 'string', description: 'bf16 / fp16 / fp32' },
        batch_size: { type: 'integer', description: 'Micro batch per GPU.' },
        seq_len: { type: 'integer', description: 'Sequence length.' },
        hidden_size: { type: 'integer', description: 'hidden size' },
        num_layers: { type: 'integer', description: 'Layer count.' },
        tp: { type: 'integer', description: 'Tensor parallelism.' },
        dp: { type: 'integer', description: 'Data parallelism.' },
        zero_stage: { type: 'integer', description: 'ZeRO stage, 0–3.' },
        recompute: { type: 'boolean', description: 'Enable activation recomputation.' },
        flash_attn: { type: 'boolean', description: 'Use FlashAttention.' },
        gpu_type: { type: 'string', description: 'GPU type, such as H800 / A100_80 / H20.' },
      },
    },
  },
  {
    name: 'inspect_node',
    description:
      'Read node hardware events and telemetry, including Xids, ECC, throttling, PCIe errors, ' +
      'and 30-day history for distinguishing isolated events from degradation.',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'Node identifier, such as lyg2103.' },
      },
      required: ['node'],
    },
  },
  {
    name: 'execute_action',
    description:
      'Execute a catalog action on a node. Only low-risk actions can run directly, such as cordon, ' +
      'job restart, or enabling expandable memory segments. Medium/high-risk actions are refused ' +
      'and require propose_fix plus operator approval. ' +
      'After execution, read state back to verify the change.',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'Node identifier, such as lyg2112.' },
        action_id: { type: 'string', description: 'Action ID from the system-provided catalog.' },
        reason: { type: 'string', description: 'One or two sentences explaining why this action is needed; stored in the event log.' },
        params: {
          type: 'object',
          description: 'Command placeholders, for example {"NODE_NAME": "lyg2112", "GPU_INDEX": 3}.',
        },
      },
      required: ['node', 'action_id', 'reason'],
    },
  },
  {
    name: 'draft_ticket',
    description:
      'Prepare a draft for an action requiring operator approval, including evidence, commands, ' +
      'and reasoning. The tool does not submit the ticket; the operator must approve submission.',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'Node identifier.' },
        action_id: { type: 'string', description: 'Action ID, such as file_rma.' },
        title: { type: 'string', description: 'Ticket title.' },
        body: { type: 'string', description: 'Decision, supporting evidence, proposed action, and points requiring confirmation.' },
        priority: { type: 'string', description: 'normal / high / urgent' },
        evidence_refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Supporting tool references, such as ["T2","T5"]. Use only refs already returned by tools.',
        },
      },
      required: ['node', 'action_id', 'title', 'body'],
    },
  },
  {
    name: 'notify_operator',
    description:
      'Queue the decision and pending tasks for the on-call operator. ' +
      'Identify actions requiring approval, especially high-risk actions.',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'Affected node.' },
        title: { type: 'string', description: 'Short title, such as "lyg2112: suspected memory degradation; RMA approval needed".' },
        text: { type: 'string', description: 'What happened, what was done, and what requires an operator decision.' },
        severity: { type: 'string', description: 'info / warning / critical' },
      },
      required: ['node', 'title', 'text'],
    },
  },
  {
    name: 'propose_fix',
    description:
      'Register each repair recommendation for the operations action list. ' +
      'Include classification and confidence. ' +
      'Choose an action_id from the system-provided catalog. ' +
      'Risk comes from the catalog and cannot be overridden in arguments or prose.',
    parameters: {
      type: 'object',
      properties: {
        action_id: {
          type: 'string',
          description:
            'Action ID from the system-provided catalog. ' +
            'Do not invent IDs. If none fits, provide a conclusion without registering an action.',
        },
        title: { type: 'string', description: 'Short title describing this recommendation.' },
        detail: { type: 'string', description: 'One or two sentences describing the action.' },
        classification: {
          type: 'string',
          description:
            'Classification: application (code defect), ' +
            'hardware (fault requiring isolation/repair), hardware_watch (observe without immediate repair), ' +
            'environment (version mismatch), config (resource/configuration issue), ' +
            'network (communication), or undetermined (insufficient evidence).',
        },
        confidence: {
          type: 'number',
          description: 'Confidence from 0 to 1; lower it when evidence is insufficient.',
        },
        should_rma: {
          type: 'boolean',
          description: 'Whether hardware repair/RMA is warranted.',
        },
        blocks_job: {
          type: 'boolean',
          description: 'Whether leaving this issue unresolved will continue to block the job.',
        },
        effort: { type: 'string', description: 'Implementation effort: low / medium / high.' },
        evidence: { type: 'string', description: 'One or two sentences of supporting facts.' },
        evidence_refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Supporting tool references, such as ["T1","T3"]. Use only refs already returned by tools.',
        },
      },
      required: ['action_id', 'title', 'detail', 'classification', 'confidence'],
    },
  },
];

/** Track evidence, citations, and outputs for one triage session. */
export class ToolState {
  /** Inject the cluster client for offline verification; disconnected tools return errors instead of claiming success. */
  constructor(evidence, pre, options = {}) {
    this.evidence = evidence;
    this.pre = pre;
    this.detail = pre?.detail || {};
    this.actions = [];
    this.citations = [];
    this.cluster = options.cluster || null;
    /** Actions executed on the simulated cluster during this session. */
    this.executions = [];
    /** Draft tickets and queued notifications produced by this session. */
    this.tickets = [];
    this.notifications = [];
  }

  /** Record a citation and return its stable T-number. */
  _cite(source, payload) {
    const ref = `T${this.citations.length + 1}`;
    this.citations.push({ ref, source, payload });
    return ref;
  }

  // ---------------------------------------------------------------- 1
  search_failure_signature({ query = '' } = {}) {
    const q = String(query || '').trim();

    if (!q) {
      return {
        ref: this._cite('search_failure_signature', { query: '' }),
        available: FAILURE_SIGNATURES.map((s) => ({ id: s.id, label: s.label, class_hint: s.class_hint })),
        note: 'No query supplied; returning all available patterns.',
      };
    }

    const byPattern = new Set(matchSignatures(q).map((h) => h.id));
    const lower = q.toLowerCase();
    const byKeyword = new Set();
    for (const sig of FAILURE_SIGNATURES) {
      const hay = [sig.label, sig.root_cause, ...sig.typical_fix, ...sig.check].join(' ').toLowerCase();

      const tokens = lower.match(/[a-z_]{3,}|[\u4e00-\u9fa5]{2,}/g) || [];
      if (tokens.some((t) => hay.includes(t))) byKeyword.add(sig.id);
    }

    const ids = [...new Set([...byPattern, ...byKeyword])];
    const matches = ids
      .map((id) => FAILURE_SIGNATURES.find((s) => s.id === id))
      .filter(Boolean)
      .map((s) => ({
        id: s.id,
        label: s.label,
        class_hint: s.class_hint,
        class_hint_note: 'Default class hint only; correlate Xid, telemetry, and version evidence before deciding.',
        root_cause: s.root_cause,
        check: s.check,
        typical_fix: s.typical_fix,
        source: s.source,
        matched_by: byPattern.has(s.id) ? 'pattern' : 'keyword',
      }));

    return {
      ref: this._cite('search_failure_signature', { query: q, matched: matches.length }),
      query: q,
      matched: matches.length,
      signatures: matches,
      note: matches.length
        ? 'Candidate patterns only; correlate lookup_xid, inspect_node, and check_compat results.'
        : 'No signature matched. Try other keywords or inspect Xids and node telemetry.',
    };
  }

  // ---------------------------------------------------------------- 2
  lookup_xid({ code } = {}) {
    const n = Number(code);
    if (!Number.isInteger(n)) return { error: 'code must be an integer' };

    const entry = XID_TABLE[n];
    if (!entry) {
      return {
        ref: this._cite('lookup_xid', { code: n, found: false }),
        code: n,
        found: false,
        error: `No knowledge-base entry for Xid ${n}; do not infer its meaning.`,
        known_codes: Object.keys(XID_TABLE).map(Number).sort((a, b) => a - b),
      };
    }

    return {
      ref: this._cite('lookup_xid', { code: n }),
      code: n,
      found: true,
      name: entry.name,
      name_en: entry.name_en,
      class: entry.class,
      class_label: CLASSES[entry.class]?.label || entry.class,
      severity: entry.severity,
      meaning: entry.meaning,
      recommended_action: entry.action,
      should_rma: entry.rma,
      source: entry.source,
      warning:
        n === 45 || n === 154
          ? 'This Xid is a consequence of an earlier event. Review preceding events for the cause.'
          : null,
    };
  }

  // ---------------------------------------------------------------- 3
  check_compat(args = {}) {
    const env = { ...(this.evidence.environment || {}) };
    for (const k of ['driver', 'cuda_runtime', 'torch', 'nccl']) {
      if (args[k]) env[k] = args[k];
    }
    const result = checkCompatibility(env);
    return {
      ref: this._cite('check_compat', { env, ok: result.ok }),
      checked: result.info,
      ok: result.ok,
      issues: result.issues,
      note: result.ok
        ? 'The supplied versions are compatible.'
        : 'Blocking version incompatibilities found; investigate them before attributing the fault to hardware.',
    };
  }

  // ---------------------------------------------------------------- 4
  estimate_memory(args = {}) {
    const cfg = { ...(this.evidence.training_config || {}) };
    for (const [k, v] of Object.entries(args)) {
      if (v !== undefined && v !== null && v !== '') cfg[k] = v;
    }
    if (!cfg.gpu_type && this.evidence.job?.gpu_type) cfg.gpu_type = this.evidence.job.gpu_type;

    const result = estimateTrainingMemory(cfg);
    if (result.error) {
      return {
        ref: this._cite('estimate_memory', { error: result.error }),
        error: result.error,
        hint: 'model_params_b (billions of parameters) is required.',
      };
    }
    return {
      ref: this._cite('estimate_memory', { inputs: result.inputs, total: result.total_range_gb }),
      ...result,
      note:
        `Model states (${result.states_gb} GB) are computed; activations are estimated. ` +
        'Total memory is reported as a range. Fit uses 90% of GPU capacity to reserve space for fragmentation.',
    };
  }

  // ---------------------------------------------------------------- 5
  /** Read live cluster state first, then fall back to a matching case snapshot. Successful observations carry their centralized provenance; errors carry no evidence tier. */
  async inspect_node({ node } = {}) {
    const target = String(node || '').trim();
    if (!target) return { error: 'node is required' };

    if (this.cluster) {
      let live = null;
      try {
        live = await this.cluster.getNode(target);
      } catch {
        live = null; // Fall back to case telemetry if the live read fails.
      }
      if (live && live.__id) {
        const tel = live.telemetry || {};
        const enriched = (tel.xid_events || []).map((e) => ({
          code: e.code,
          gpu: e.gpu ?? null,
          at: e.at,
          count: e.count ?? 1,
          name: XID_TABLE[e.code]?.name || null,
          known: Boolean(XID_TABLE[e.code]),
        }));
        return {
          ref: this._cite('inspect_node', { node: target, source: 'live', events: enriched.length }),
          node: target,
          found: true,
          source: 'live',

          node_status: live.status,
          cordoned: live.cordoned ?? null,
          schedulable: live.schedulable ?? null,
          draining: live.draining ?? null,
          gpu_type: live.gpu_type,
          running_jobs: (live.jobs || []).map((j) => ({
            id: j.id, user: j.user, gpus: j.gpus, state: j.state,
          })),

          smi_ok: tel.smi_ok ?? null,
          smi_error: tel.smi_error || null,
          lspci_gpu_count: tel.lspci_gpu_count ?? null,
          kernel_module_loaded: tel.kernel_module_loaded ?? null,
          module_for_kernel: tel.module_for_kernel ?? null,
          secure_boot: tel.secure_boot ?? null,
          hung_process: tel.hung_process || null,
          gpu_util_pct: tel.gpu_util_pct ?? null,
          progress_stalled_minutes: tel.progress_stalled_minutes ?? null,

          xid_events: enriched,
          ecc_uncorrectable: tel.ecc_uncorrectable ?? null,
          ecc_correctable: tel.ecc_correctable ?? null,
          row_remap_pending: tel.row_remap_pending ?? null,
          reset_count: tel.reset_count ?? null,
          history_30d: tel.history_30d || null,

          ...evidenceTier('live'),
        };
      }
    }

    const current = this.evidence.job?.node || '';
    const telemetry = this.evidence.node_telemetry;

    if (!telemetry || (target && current && target !== current)) {
      return {
        ref: this._cite('inspect_node', { node: target, found: false }),
        node: target,
        found: false,
        error: `No telemetry available for node ${target}.`,
        available_nodes: current ? [current] : [],
        hint:
          'Query only nodes with available telemetry; do not invent node state. '
          + 'Use scan_cluster to discover available nodes.',

      };
    }

    const enriched = (telemetry.xid_events || []).map((e) => ({
      ...e,
      name: XID_TABLE[e.code]?.name || null,
      class: XID_TABLE[e.code]?.class || null,
    }));

    return {
      ref: this._cite('inspect_node', { node: target, events: enriched.length }),
      node: target,
      found: true,
      source: 'case',
      window: telemetry.window,
      xid_events: enriched,
      ecc_uncorrectable: telemetry.ecc_uncorrectable,
      ecc_correctable: telemetry.ecc_correctable,
      clock_throttle: telemetry.clock_throttle,
      pcie_aer: telemetry.pcie_aer || null,
      gsp_firmware: telemetry.gsp_firmware || null,
      history_30d: telemetry.history_30d || null,
      note: telemetry.note,
      ...evidenceTier('snapshot'),
    };
  }

  // ---------------------------------------------------------------- 6
  /** Return observed signals from cluster state; classification requires detailed node evidence. */
  async scan_cluster({ include_healthy = false } = {}) {
    if (!this.cluster) {
      return {
        error: 'This session is not connected to a cluster; scan unavailable.',
        hint: 'Case mode inspects one node. Open patrol mode to scan the cluster.',
      };
    }

    const nodes = await this.cluster.listNodes();
    const flagged = [];
    for (const n of nodes) {
      const signals = nodeSignals(n);
      if (!signals.length && !include_healthy) continue;
      flagged.push({
        node: n.node,
        gpu_type: n.gpu_type,
        node_status: n.status,
        schedulable: n.schedulable ?? true,
        cordoned: n.cordoned ?? false,
        running_jobs: (n.jobs || []).map((j) => `${j.id} (${j.user}, ${j.state})`),
        signals,
      });
    }
    flagged.sort((a, b) => b.signals.length - a.signals.length);

    return {
      ref: this._cite('scan_cluster', { scanned: nodes.length, flagged: flagged.length }),
      scanned_nodes: nodes.length,
      needs_attention: flagged,
      note:
        'Signals are machine-extracted observations. A signal such as Xid 94 ' +
        'can lead to different diagnoses on different nodes; inspect each node before deciding.',
      next:
        flagged.length
          ? 'Call inspect_node for each needs_attention node, then decide its classification and RMA requirement.'
          : 'No nodes require attention in this scan.',

      ...evidenceTier('live'),
    };
  }

  // ---------------------------------------------------------------- 7
  /** Enforce the catalog risk gate before connection checks. Only low-risk actions execute directly; medium/high risk require operator approval through propose_fix. */
  async execute_action({ node = '', action_id = '', reason = '', params = {} } = {}) {
    const act = getAction(action_id);
    if (!act) {
      return {
        error: `Unknown action "${action_id || '(empty)'}"; no operation executed.`,
        available_actions: selectableActions(),
      };
    }
    if (act.discouraged) {
      return { error: `"${act.label}" is discouraged and cannot be executed.`, instead: act.instead };
    }

    //

    if (act.risk !== 'low') {
      const lv = RISK_LEVELS[act.risk];
      return {
        refused: true,
        action_id: act.id,
        action_label: act.label,
        risk: act.risk,
        risk_label: lv.label,
        error:
          `"${act.label}" is classified as ${lv.label} (${lv.rule}). ` +
          `Operator approval is required: ${lv.approval}. Direct execution is not allowed.`,
        instead:
          'Use propose_fix with the action_id and evidence refs for operator approval. '
          + 'After approval, the system can execute it. Use draft_ticket to prepare a ticket if needed.',
        allowed_to_execute_now: lowRiskActionIds(),
      };
    }

    if (!this.cluster) {
      return {
        error: 'This session is not connected to a cluster; execution unavailable.',
        hint: 'This action permits direct execution, but the session has no simulated-cluster connection.',
      };
    }

    const out = await this.cluster.executeAction({
      node, actionId: action_id, params, actor: 'agent', reason,
    });
    if (!out.ok && out.error) {
      return {
        ref: this._cite('execute_action', { node, action_id, verified: false, error: out.error }),
        executed: false,
        error: `Execution failed: ${out.error}`,
      };
    }

    this.executions.push({ node, action_id, event: out.event, before: out.before, after: out.after });

    return {
      ref: this._cite('execute_action', { node, action_id, verified: out.verified }),
      executed: true,
      node,
      action_id,
      action_label: act.label,
      risk: act.risk,
      describe: out.planned.describe,
      fields_written: Object.keys(out.planned.fields),

      verified: out.verified,
      before: { status: out.before?.status, cordoned: out.before?.cordoned, schedulable: out.before?.schedulable },
      after: { status: out.after?.status, cordoned: out.after?.cordoned, schedulable: out.after?.schedulable },
      note: out.verified
        ? 'Server state was read back and the change was verified.'
        : 'Read-back state differs from the expected state; report that the action may not have taken effect.',
    };
  }

  // ---------------------------------------------------------------- 8
  /** Prepare draft tickets only; submission requires an operator. */
  async draft_ticket({
    node = '', action_id = '', title = '', body = '', priority = 'normal', evidence_refs = [],
  } = {}) {
    const act = getAction(action_id);
    if (!act) {
      return { error: `Unknown action "${action_id || '(empty)'}".`, available_actions: selectableActions() };
    }
    if (!this.cluster) return { error: 'This session is not connected to a cluster; ticket creation unavailable.' };

    const validRefs = (Array.isArray(evidence_refs) ? evidence_refs : [])
      .filter((r) => this.citations.some((c) => c.ref === r));

    const t = await this.cluster.createTicket({
      node, actionId: action_id, title, body, evidence_refs: validRefs, priority, created_by: 'agent',
    });
    this.tickets.push(t);

    return {
      ref: this._cite('draft_ticket', { node, action_id, ticket: t.__id }),
      created: t.__id,
      status: 'draft',
      action_label: act.label,
      dropped_refs: (Array.isArray(evidence_refs) ? evidence_refs : []).filter(
        (r) => !this.citations.some((c) => c.ref === r),
      ),
      note:
        'Ticket prepared as a draft. Submission requires operator approval.',
      next: 'Use notify_operator to tell the on-call operator that approval is pending.',
    };
  }

  // ---------------------------------------------------------------- 9
  /** Queue notifications without claiming external delivery. */
  async notify_operator({ node = '', title = '', text = '', severity = 'warning' } = {}) {
    if (!this.cluster) return { error: 'This session is not connected to a cluster; notification unavailable.' };
    const n = await this.cluster.notify({ node, title, text, severity, channel: 'im' });
    this.notifications.push(n);
    return {
      ref: this._cite('notify_operator', { node, title }),
      delivered_to: 'On-call notification queue',
      status: 'queued',
      severity,
      title,
      note:
        'Notification queued with status queued. '
        + 'Connect an IM or email delivery channel for external delivery.',
    };
  }

  // ---------------------------------------------------------------- 10
  propose_fix({
    action_id,
    title,
    detail,
    classification = 'undetermined',
    confidence = 0.5,
    should_rma = null,
    blocks_job = null,
    effort = 'medium',
    evidence = '',
    evidence_refs = [],
  } = {}) {

    //

    //

    const act = getAction(action_id);
    if (!act) {
      return {
        error: `Unknown action "${action_id || '(empty)'}"; recommendation not registered.`,
        available_actions: selectableActions(),
        hint:
          'Call propose_fix again with an action_id from the available catalog. ' +
          'Do not invent IDs or override risk. ' +
          'If no action fits, explain the recovery direction in the final decision without registering one.',
      };
    }
    if (act.discouraged) {
      return {
        error: `"${act.label}" is discouraged: ${act.reason}`,
        instead: act.instead,
        available_actions: selectableActions(),
      };
    }

    const cls = CLASSES[classification] ? classification : 'undetermined';
    const conf = Math.max(0, Math.min(1, Number(confidence) || 0));

    const validRefs = Array.isArray(evidence_refs)
      ? evidence_refs.filter((r) => this.citations.some((c) => c.ref === r))
      : [];
    const droppedRefs = Array.isArray(evidence_refs)
      ? evidence_refs.filter((r) => !this.citations.some((c) => c.ref === r))
      : [];

    const action = {
      id: `F${this.actions.length + 1}`,
      action_id: act.id,

      action_label: act.label,
      risk: act.risk,
      risk_label: RISK_LEVELS[act.risk].label,
      risk_rule: RISK_LEVELS[act.risk].rule,
      approval_requirement: RISK_LEVELS[act.risk].approval,
      affects: act.affects,
      cmds: act.cmds,
      params: act.params,
      expect: act.expect,
      rollback: act.rollback,
      note: act.note,
      source: act.source,
      title: String(title || act.label).slice(0, 60),
      detail: String(detail),
      classification: cls,
      classification_label: CLASSES[cls].label,
      should_rma: should_rma === null ? null : Boolean(should_rma),
      blocks_job: blocks_job === null ? null : Boolean(blocks_job),
      confidence: Math.round(conf * 100) / 100,
      effort: String(effort),
      evidence: String(evidence || ''),
      evidence_refs: validRefs,
    };
    this.actions.push(action);

    const out = {
      registered: action.id,
      total_fixes: this.actions.length,
      classification: cls,

      risk: act.risk,
      risk_label: RISK_LEVELS[act.risk].label,
      approval_required: RISK_LEVELS[act.risk].approval,
      command: act.cmds,
      rollback: act.rollback,
    };
    if (droppedRefs.length) {
      out.warning = `Unknown evidence refs discarded: ${droppedRefs.join(', ')}. Use only refs returned by tools.`;
    }
    return out;
  }
}

/** Extract observed anomalies without assigning a fault class. */
export function nodeSignals(n = {}) {
  const out = [];
  const t = n.telemetry || {};

  if (n.status && !['healthy', 'rebooting'].includes(n.status)) {
    out.push(`Node status: ${n.status}`);
  }
  if (t.smi_ok === false) {
    out.push(`nvidia-smi cannot read devices${t.smi_error ? `: ${t.smi_error}` : ''}`);
  }
  if (
    typeof t.lspci_gpu_count === 'number' &&
    typeof n.gpu_count === 'number' &&
    t.lspci_gpu_count < n.gpu_count
  ) {
    out.push(`lspci lists ${t.lspci_gpu_count} GPUs; expected ${n.gpu_count}`);
  }
  for (const e of t.xid_events || []) {
    const known = XID_TABLE[e.code];
    out.push(
      `Xid ${e.code}${known ? ` (${known.name})` : ' (not in knowledge base)'}` +
        ` ×${e.count ?? 1}` +
        (e.gpu !== undefined && e.gpu !== null ? `, GPU ${e.gpu}` : '') +
        (e.at ? `; latest ${e.at}` : ''),
    );
  }
  if (t.ecc_uncorrectable > 0) out.push(`Uncorrectable ECC count: ${t.ecc_uncorrectable}`);
  if (t.row_remap_pending > 0) out.push(`Pending row remaps: ${t.row_remap_pending}`);

  const h = t.history_30d;
  if (h) {
    if (h.xid94_count > 0) out.push(`Xid 94 count over 30 days: ${h.xid94_count}`);
    if (h.ecc_correctable_trend && h.ecc_correctable_trend !== 'flat') {
      out.push(`Correctable ECC trend: ${h.ecc_correctable_trend}`);
    }
  }
  if (typeof t.ecc_correctable === 'number' && t.ecc_correctable > 0) {
    out.push(`Current correctable ECC count: ${t.ecc_correctable}`);
  }
  if (t.hung_process) {
    const p = t.hung_process;
    out.push(`Process ${p.pid}: state ${p.state}, waiting in ${p.wchan} for ${p.etime}`);
  }
  if (t.progress_stalled_minutes) {
    out.push(
      `Training stalled for ${t.progress_stalled_minutes} minutes with GPU utilization at ${t.gpu_util_pct ?? '?'}%`,
    );
  }
  if (t.module_for_kernel === false) out.push('NVIDIA module was not built for the current kernel');
  if (t.secure_boot === true) out.push('Secure Boot is enabled');

  return out;
}

/** Low-risk actions available for direct execution. */
const lowRiskActionIds = () => ACTION_LIST.filter((a) => a.risk === 'low').map((a) => a.id);

/** Allowlisted tool names match ToolState method names; one registry controls permitted parameters. */
export const TOOL_PARAMS = {
  scan_cluster: ['include_healthy'],
  search_failure_signature: ['query'],
  lookup_xid: ['code'],
  check_compat: ['driver', 'cuda_runtime', 'torch', 'nccl'],
  estimate_memory: [
    'model_params_b', 'precision', 'batch_size', 'seq_len', 'hidden_size',
    'num_layers', 'tp', 'dp', 'zero_stage', 'recompute', 'flash_attn', 'gpu_type',
  ],
  inspect_node: ['node'],
  execute_action: ['node', 'action_id', 'reason', 'params'],
  draft_ticket: ['node', 'action_id', 'title', 'body', 'priority', 'evidence_refs'],
  notify_operator: ['node', 'title', 'text', 'severity'],
  propose_fix: [
    'action_id', 'title', 'detail', 'classification', 'confidence', 'should_rma',
    'blocks_job', 'effort', 'evidence', 'evidence_refs',
  ],
};

/** Case mode exposes diagnosis tools; patrol adds cluster operations. */
export const CASE_MODE_TOOLS = [
  'search_failure_signature',
  'lookup_xid',
  'check_compat',
  'estimate_memory',
  'inspect_node',
  'propose_fix',
];

/** Return six case tools or all ten patrol tools. */
export function toolSpecsFor(mode = 'case') {
  if (mode === 'patrol') return TOOL_SPECS;
  const allow = new Set(CASE_MODE_TOOLS);
  return TOOL_SPECS.filter((s) => allow.has(s.name));
}

/** Discard parameters outside the allowlist, including model-supplied risk. Await async operations and return failures as tool results. */
export async function dispatchTool(name, args, state) {
  const key = String(name || '').trim();
  const allowed = TOOL_PARAMS[key];
  if (!allowed) {
    return {
      error: `Unknown tool: ${key}`,
      available_tools: Object.keys(TOOL_PARAMS).sort(),
    };
  }
  const clean = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (allowed.includes(k)) clean[k] = v;
  }
  try {
    return await state[key](clean);
  } catch (exc) {

    return { error: `${(exc && exc.name) || 'Error'}: ${(exc && exc.message) || exc}` };
  }
}

/** Return all citations produced by this session. */
export function citationIndex(state) {
  return (state?.citations || []).map((c) => ({ ref: c.ref, source: c.source }));
}

/** Run the offline rule baseline for verification. */
export function ruleOnlyScan(text) {
  return { xids: extractXids(text), signatures: matchSignatures(text) };
}
