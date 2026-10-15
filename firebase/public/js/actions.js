/** The catalog owns risk, impact, commands, and rollback. Models select IDs only. Medium risk requires impact acknowledgment; high risk requires a change ticket, approver, and final confirmation. */
export const RISK_LEVELS = {
  low: {
    label: 'Low risk',
    short: 'Low',
    color: 'green',
    rule: 'Reversible; affects only the current job process',
    approval: 'Batch approval',
    approval_detail: 'Select and approve multiple actions together.',
  },
  medium: {
    label: 'Medium risk',
    short: 'Medium',
    color: 'amber',
    rule: 'Affects other jobs on the node or requires a brief interruption',
    approval: 'Individual approval and impact acknowledgment',
    approval_detail: 'Approve each action and acknowledge its impact on other jobs.',
  },
  high: {
    label: 'High risk',
    short: 'High',
    color: 'red',
    rule: 'Irreversible, involves hardware assets, or affects other nodes or users',
    approval: 'Individual approval, change ticket, approver, and final confirmation',
    approval_detail: 'Enter a change ticket and approver, then confirm before submission.',
  },
};

export const RISK_ORDER = ['low', 'medium', 'high'];

/** Catalog fields define IDs, risk, impact, placeholders, expected results, rollback, and sources. Adapt platform-specific commands before use. */
export const ACTIONS = {

  set_expandable_segments: {
    id: 'set_expandable_segments',
    label: 'Enable expandable memory segments',
    risk: 'low',
    affects: 'Current job process only',
    applies_to: ['config'],
    cmds: ['export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True'],
    params: [],
    expect: 'After restart, fragmentation-related OOM stops and nvidia-smi memory usage is more stable.',
    rollback: 'Run unset PYTORCH_CUDA_ALLOC_CONF or remove it from the launch script, then restart.',
    note: 'Set this in the launch script or container environment so it persists across shells.',
    source: 'https://docs.pytorch.org/docs/stable/notes/cuda.html#environment-variables',
  },
  reduce_micro_batch: {
    id: 'reduce_micro_batch',
    label: 'Reduce micro batch and increase gradient accumulation',
    risk: 'low',
    affects: 'Current job process only',
    applies_to: ['config'],
    cmds: [
      '# Halve micro_batch_size and double gradient_accumulation_steps.',
      '# Example: micro_batch_size 8 to 4; gradient_accumulation_steps 4 to 8.',
      '# Keep global batch size unchanged while reducing peak memory.',
    ],
    params: [],
    expect: 'Peak GPU memory falls roughly with micro batch size; steps take longer and global batch stays unchanged.',
    rollback: 'Restore both parameters and restart the job.',
    note: 'Keep global batch size and learning rate unchanged to preserve training behavior.',
    source: null,
  },
  enable_gradient_checkpointing: {
    id: 'enable_gradient_checkpointing',
    label: 'Enable gradient checkpointing',
    risk: 'low',
    affects: 'Current job process only',
    applies_to: ['config'],
    cmds: [
      '# Enable after constructing the model (transformers example).',
      'model.gradient_checkpointing_enable()',
    ],
    params: [],
    expect: 'Activation memory falls; step time increases by about 20–30%.',
    rollback: 'Call model.gradient_checkpointing_disable() and restart.',
    note: 'Recomputation trades compute time for memory; use it when simpler reductions are insufficient.',
    source: null,
  },
  restart_job: {
    id: 'restart_job',
    label: 'Restart the job process',
    risk: 'low',
    affects: 'Current job process only',
    applies_to: ['application', 'config'],
    cmds: [
      'ps -eo pid,ppid,stat,etime,args | grep -E "<TRAIN_CMD>" | grep -v grep',
      '# Confirm S/R process state; for D state, check process_d_state before restarting.',
      'kill -TERM <PID>',
    ],
    params: ['TRAIN_CMD', 'PID'],
    expect: 'The process exits and its GPU memory drops to zero in nvidia-smi.',
    rollback: 'Resubmit the job; this action changes no persistent configuration.',
    note: 'Restart after Xid 43 because the process CUDA context is no longer usable.',
    source: null,
  },
  align_torch_wheel: {
    id: 'align_torch_wheel',
    label: 'Install a torch wheel compatible with the driver',
    risk: 'low',
    affects: 'Current job process only',
    applies_to: ['environment'],
    cmds: [
      '# Compare the driver CUDA ceiling with the CUDA version used to build torch.',
      'nvidia-smi | head -4',
      'python -c "import torch;print(torch.__version__, torch.version.cuda)"',
      '# Install the matching cuXXX wheel (choose cu121, cu124, or cu126).',
      'pip install --force-reinstall torch --index-url https://download.pytorch.org/whl/cu<CUDA_TAG>',
    ],
    params: ['CUDA_TAG'],
    expect: 'torch.cuda.is_available() returns True and CUDA driver version is insufficient stops.',
    rollback: 'Reinstall the original torch wheel with pip install --force-reinstall and its original version.',
    note: 'Change the container only. Updating the shared host driver affects every job on the node.',
    source: null,
  },

  cordon_node: {
    id: 'cordon_node',
    label: 'Cordon the node',
    risk: 'low',
    affects: 'Future scheduling only; running jobs continue',
    applies_to: ['hardware', 'hardware_watch', 'environment', 'network'],
    cmds: [
      'kubectl cordon <NODE_NAME>',
      '# For other schedulers, mark unschedulable/offline without evicting running jobs.',
    ],
    params: ['NODE_NAME'],
    expect: 'No new jobs are scheduled on this node; running jobs continue.',
    rollback: 'kubectl uncordon <NODE_NAME>',
    note: 'Cordon blocks new jobs and is reversible. '
      + 'For suspected hardware degradation, cordon first, observe, then decide whether to drain. '
      + 'Draining can interrupt jobs and lose progress.',
    source: null,
  },

  reload_nvidia_modules: {
    id: 'reload_nvidia_modules',
    label: 'Reload NVIDIA kernel modules',
    risk: 'medium',
    affects: 'All GPU jobs on this node',
    applies_to: ['environment'],
    cmds: [
      'sudo systemctl stop nvidia-persistenced',
      'sudo rmmod nvidia_uvm nvidia_drm nvidia_modeset nvidia',
      'sudo modprobe nvidia && sudo modprobe nvidia_uvm',
      'nvidia-smi',
    ],
    params: [],
    expect: 'nvidia-smi responds normally and its driver version matches the loaded module.',
    rollback: 'If modules cannot be reloaded, reboot with sudo reboot.',
    note: 'Unload in dependency order: uvm, drm, modeset, nvidia. '
      + 'If rmmod reports "Module is in use", stop GPU processes before retrying.',
    source: null,
  },
  gpu_reset: {
    id: 'gpu_reset',
    label: 'Reset the selected GPU',
    risk: 'medium',
    affects: 'Processes using this GPU',
    applies_to: ['environment', 'hardware_watch'],
    cmds: ['nvidia-smi -i <GPU_INDEX> -r'],
    params: ['GPU_INDEX'],
    expect: 'The command returns "All done." and nvidia-smi -i <GPU_INDEX> still lists the GPU.',
    rollback: 'If the GPU disappears from lspci -d 10de: after reset, investigate a PCIe fault. '
      + 'Reboot the node or escalate for hardware repair.',
    note: 'Release active GPU processes before resetting; reset clears remaining contexts.',
    source: null,
  },
  reboot_node: {
    id: 'reboot_node',
    label: 'Reboot the node',
    risk: 'medium',
    affects: 'All jobs on this node',
    applies_to: ['environment', 'hardware_watch'],
    cmds: ['sudo shutdown -r +1 "GPU maintenance, scheduled reboot"', '# Or drain and reboot through the platform.'],
    params: [],
    expect: 'Check for recurring Xid after the node returns; recurrence warrants hardware investigation.',
    rollback: 'Reboot cannot be undone. Confirm checkpoint recovery before proceeding.',
    note: 'Compare errors before and after reboot to distinguish transient software state from persistent faults. '
      + 'Record recurring errors for further investigation.',
    source: null,
  },
  align_driver_version: {
    id: 'align_driver_version',
    label: 'Align the node driver version',
    risk: 'medium',
    affects: 'All jobs on this node',
    applies_to: ['environment'],
    cmds: [
      '# Confirm the target version against the cluster baseline.',
      'nvidia-smi --query-gpu=driver_version --format=csv,noheader | sort -u',
      'sudo apt-get install --allow-downgrades -y nvidia-driver-<TARGET_VERSION>',
      'sudo reboot',
    ],
    params: ['TARGET_VERSION'],
    expect: 'The driver matches the cluster baseline and version-related NVML errors stop.',
    rollback: 'Reinstall the original nvidia-driver package version and reboot.',
    note: 'Mixed driver components can cause NVML mismatch errors. '
      + 'Use the platform rollout process to keep versions consistent.',
    source: null,
  },
  drain_node: {
    id: 'drain_node',
    label: 'Drain jobs from the node',
    risk: 'medium',
    affects: 'All jobs on this node; distributed jobs may also be affected',
    applies_to: ['hardware', 'hardware_watch', 'environment'],
    cmds: [
      '# K8s: mark unschedulable and evict workload Pods.',
      'kubectl drain <NODE_NAME> --ignore-daemonsets --delete-emptydir-data',
      '# For other schedulers, mark drained/offline and migrate jobs through the platform.',
    ],
    params: ['NODE_NAME'],
    expect: 'No new jobs reach the node; existing jobs exit or migrate under platform policy.',
    rollback: 'Run kubectl uncordon <NODE_NAME> to restore scheduling.',
    note: 'Draining can interrupt jobs. Confirm checkpoint and migration behavior before approval. '
      + 'GPU retirement separately removes capacity from the scheduling pool.',
    source: null,
  },

  file_rma: {
    id: 'file_rma',
    label: 'Submit a hardware repair request (RMA)',
    risk: 'high',
    affects: 'Hardware assets and procurement/vendor workflow',
    applies_to: ['hardware'],
    cmds: [
      '# 1. Collect the GPU serial number for the ticket.',
      'nvidia-smi --query-gpu=index,serial,pci.bus_id --format=csv',
      '# 2. Collect dmesg, driver state, and ECC counters.',
      'sudo nvidia-bug-report.sh --safe-mode --output-file /tmp/$(hostname)-gpu<GPU_INDEX>-$(date +%F).tgz',
      '# 3. Save Xid history separately for the ticket.',
      "sudo dmesg -T | grep -iE 'Xid|NVRM' | tail -200 > /tmp/$(hostname)-xid.log",
      '# 4. Attach evidence files and the serial number to the repair ticket.',
    ],
    params: ['GPU_INDEX'],
    expect: 'The vendor accepts the ticket and the asset is marked under repair.',
    rollback: 'Withdraw the ticket before vendor acceptance.',
    note: 'RMA removes GPU capacity from the cluster. '
      + 'Require confirmed hardware evidence rather than a single isolated Xid.',
    source: null,
  },
  retire_gpu: {
    id: 'retire_gpu',
    label: 'Retire the GPU',
    risk: 'high',
    affects: 'Hardware assets and cluster capacity',
    applies_to: ['hardware'],
    cmds: [
      '# Remove this GPU from scheduling using the installed device plugin.',
      '# K8s with NVIDIA device plugin: label the node and exclude this GPU.',
      'kubectl label node <NODE_NAME> nvidia.com/gpu-<GPU_INDEX>=retired --overwrite',
      '# Verify the scheduler no longer assigns jobs to this GPU.',
    ],
    params: ['NODE_NAME', 'GPU_INDEX'],
    expect: 'No new jobs reach this GPU and its memory usage drops to zero.',
    rollback: 'Remove the label with kubectl label node <NODE_NAME> nvidia.com/gpu-<GPU_INDEX>-.',
    note: 'Remove the affected GPU from the scheduling pool before repair when needed. '
      + 'Adapt labels and exclusions to the installed device plugin.',
    source: null,
  },
  bulk_driver_upgrade: {
    id: 'bulk_driver_upgrade',
    label: 'Roll out a driver upgrade',
    risk: 'high',
    affects: 'The whole cluster or multiple nodes',
    applies_to: ['environment'],
    cmds: [
      '# Roll out in batches.',
      '# 1. Validate the new driver with current torch/NCCL on one non-production node.',
      '# 2. Deploy in batches with observation windows.',
      'ansible-playbook -i inventory upgrade-nvidia-driver.yml --limit batch1',
      '# 3. After each batch, run nvidia-smi and a small allreduce smoke test.',
    ],
    params: [],
    expect: 'Driver versions match across the cluster and version-related NVML/NCCL failures stop.',
    rollback: 'Roll each node back using previous driver packages retained before the upgrade.',
    note: 'Confirm previous driver packages are available before approval. '
      + 'Missing rollback packages can extend an outage.',
    source: null,
  },
};

export const DISCOURAGED_ACTIONS = {
  raise_nccl_timeout: {
    id: 'raise_nccl_timeout',
    label: 'Increase the collective communication timeout',
    risk: 'medium',
    affects: 'Delays detection while leaving the cause unresolved',
    discouraged: true,
    reason: 'NCCL timeouts can follow IB/NVLink/NIC faults or a slow GPU. '
      + 'Increasing the timeout only delays failure, '
      + 'which increases lost progress and can complicate recovery.',
    instead: 'Check nvidia-smi nvlink -s, ibstat, and correlated Xid/ECC events first.',
    cmds: ['export NCCL_TIMEOUT=<LONGER_SECONDS>', '# Not recommended as a direct fix.'],
    params: [],
    expect: 'Failure occurs later while the root cause remains.',
    rollback: 'Restore the previous timeout and investigate the cause.',
    note: 'Shown for reference and excluded from selectable actions.',
    source: null,
  },
};

export const ACTION_LIST = Object.values(ACTIONS);

const byId = { ...ACTIONS, ...DISCOURAGED_ACTIONS };

/** Return null for unknown action IDs so callers can reject them. */
export function getAction(id) {
  return byId[String(id || '').trim()] || null;
}

export function isDiscouraged(id) {
  const a = getAction(id);
  return Boolean(a && a.discouraged);
}

/** Only supported actions are exposed to the model. */
export function selectableActions() {
  return ACTION_LIST.map((a) => ({ id: a.id, label: a.label, risk: a.risk, applies_to: a.applies_to }));
}

/** Suggestions do not restrict selection of other supported actions. */
export function suggestActions(classification) {
  if (!classification) return [];
  return ACTION_LIST.filter((a) => a.applies_to.includes(classification));
}

/** Group by catalog risk to preserve each approval gate. */
export function buildApprovalPlan(actionIds = []) {
  const items = [];
  const unknown = [];

  for (const id of actionIds) {
    const a = getAction(id);
    if (!a) {
      unknown.push(id);
      continue;
    }

    if (!a.rollback) {
      unknown.push(id);
      continue;
    }
    items.push(a);
  }

  const groups = {};
  for (const level of RISK_ORDER) {
    groups[level] = {
      level,
      ...RISK_LEVELS[level],
      items: items.filter((a) => a.risk === level),
    };
  }

  return {
    groups,
    total: items.length,
    unknown,
    highestRisk: RISK_ORDER.slice().reverse().find((l) => groups[l].items.length) || null,
  };
}

/** Enforce approval requirements here as well as in the UI. */
export function validateApproval({ actionIds = [], approvals = {}, ticket = '', approver = '' } = {}) {
  const plan = buildApprovalPlan(actionIds);
  const blocking = [];

  for (const level of RISK_ORDER) {
    const group = plan.groups[level];
    for (const a of group.items) {
      const state = approvals[a.id];
      if (!state || state.decision !== 'approve') continue;

      if (level === 'high') {
        if (!String(ticket).trim()) blocking.push(`${a.label}: high-risk actions require a change ticket`);
        if (!String(approver).trim()) blocking.push(`${a.label}: high-risk actions require an approver`);
      }
      if (level === 'medium' && state.impact_ack !== true) {
        blocking.push(`${a.label}: medium-risk actions require impact acknowledgment`);
      }
    }
  }

  return { ok: blocking.length === 0, blocking, plan };
}

/** Export decisions, citations, commands, rollback, and approvals; mark pending and rejected actions as non-executable. */
export function buildExecPackage({
  evidence = null,
  conclusion = null,
  citations = [],
  actionIds = [],
  approvals = {},
  ticket = '',
  approver = '',
  model = '',
  mode = '',
  generatedAt = null,
} = {}) {
  const plan = buildApprovalPlan(actionIds);
  const stamp = generatedAt || new Date().toISOString();
  const L = [];

  L.push('# Training Failure Triage · Execution Package');
  L.push('');
  L.push(`Generated: ${stamp}`);
  if (model) L.push(`Triage model: ${model}${mode ? ` (${mode})` : ''}`);
  L.push('');

  L.push('## 1. Triage decision');
  L.push('');
  if (conclusion) {
    L.push(`- Classification: **${conclusion.classification_label || conclusion.classification || 'Undetermined'}**`);
    if (conclusion.should_rma !== null && conclusion.should_rma !== undefined) {
      L.push(`- Hardware repair: **${conclusion.should_rma ? 'Required (RMA)' : 'Not required'}**`);
    }
    if (typeof conclusion.confidence === 'number') {
      L.push(`- Confidence: ${(conclusion.confidence * 100).toFixed(0)}%`);
    }
    if (conclusion.summary) {
      L.push('');
      L.push(conclusion.summary);
    }
  } else {
    L.push('(No decision summary attached.)');
  }
  L.push('');

  L.push('## 2. Evidence');
  L.push('');
  if (citations.length) {
    for (const c of citations) {
      const pl = c.payload ? JSON.stringify(c.payload) : '';
      L.push(`- **${c.ref}** | ${c.source}${pl ? ` | ${truncate(pl, 220)}` : ''}`);
    }
  } else {
    L.push('(No tool calls recorded.)');
  }
  if (evidence) {
    L.push('');
    L.push('Original evidence:');
    L.push('```json');
    L.push(truncate(JSON.stringify(evidence, null, 2), 3000));
    L.push('```');
  }
  L.push('');

  L.push('## 3. Actions');
  L.push('');
  let idx = 0;
  for (const level of RISK_ORDER) {
    const group = plan.groups[level];
    if (!group.items.length) continue;
    L.push(`### ${group.label} (${group.approval})`);
    L.push('');
    for (const a of group.items) {
      idx += 1;
      const state = approvals[a.id] || {};
      const decision = state.decision || 'pending';
      const approved = decision === 'approve';
      const rejected = decision === 'reject';

      L.push(`#### ${idx}. ${a.label}`);
      L.push('');
      if (rejected) {
        L.push('> **Rejected. Do not execute.**');
        L.push('');
        continue;
      }
      if (!approved) {
        L.push('> **Not approved. Do not execute.**');
        L.push('');
      }
      L.push(`- Risk: ${group.label} (${group.rule})`);
      L.push(`- Impact: ${a.affects}`);
      if (a.params.length) L.push(`- Replace parameters: ${a.params.map((p) => `\`<${p}>\``).join(', ')}`);
      if (a.note) L.push(`- Note: ${a.note}`);
      if (approved) {
        L.push(`- Approval: ${state.decidedAt || '(time not recorded)'}${ticket ? ` | Change ticket ${ticket}` : ''}${approver ? ` | Approver ${approver}` : ''}`);
        if (state.impact_ack) L.push('- Impact acknowledged');
      }
      L.push('');
      L.push('Commands:');
      L.push('```bash');
      for (const c of a.cmds) L.push(c);
      L.push('```');
      L.push(`Expected result: ${a.expect}`);
      L.push(`Rollback: ${a.rollback}`);
      L.push('');
    }
  }

  if (!idx) {
    L.push('(No actions passed validation; no executable content generated.)');
    L.push('');
  }

  L.push('## 4. Discouraged actions');
  L.push('');
  for (const d of Object.values(DISCOURAGED_ACTIONS)) {
    L.push(`- **${d.label}** (${d.id}): ${d.reason}`);
    if (d.instead) L.push(`  - Recommended alternative: ${d.instead}`);
  }
  L.push('');

  L.push('## 5. Approval record');
  L.push('');
  L.push(`- Change ticket: ${ticket || '(not provided)'}`);
  L.push(`- Approver: ${approver || '(not provided)'}`);
  const approvedCount = Object.values(approvals).filter((s) => s.decision === 'approve').length;
  const rejectedCount = Object.values(approvals).filter((s) => s.decision === 'reject').length;
  L.push(`- Approved: ${approvedCount} | Rejected: ${rejectedCount}`);
  L.push('');
  L.push('---');
  L.push('');
  L.push('> This package requires manual execution. '
    + 'Copy commands to the target node after completing the required approval.');

  return L.join('\n');
}

function truncate(s, n) {
  const t = String(s);
  return t.length > n ? `${t.slice(0, n)}… (truncated; ${t.length} characters total)` : t;
}

/** Attach approval state for rendering; risk comes from the catalog. */
export function decorateActions(actionIds = [], approvals = {}) {
  return actionIds
    .map((id) => {
      const a = getAction(id);
      if (!a) return null;
      return {
        ...a,
        risk_label: RISK_LEVELS[a.risk].label,
        risk_rule: RISK_LEVELS[a.risk].rule,
        approval_requirement: RISK_LEVELS[a.risk].approval,
        state: approvals[a.id] || { decision: 'pending' },
      };
    })
    .filter(Boolean);
}
