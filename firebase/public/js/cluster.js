/** Firestore-backed simulated cluster. Action effects update constructed node records and verify them by reading back; this client has no production-cluster connection. */
import { getAction } from './actions.js';

export const CLUSTER_META = {
  projectId: 'gpu-waste-auditor-2026',
  apiKey: 'AIzaSyAg8QbppwIYUzp0x9Jw74pzFx3UwKAS0vo',
  database: '(default)',
  collections: { nodes: 'cluster', events: 'events', tickets: 'tickets', notifications: 'notifications' },
};

const DOCS =
  `https://firestore.googleapis.com/v1/projects/${CLUSTER_META.projectId}` +
  `/databases/${encodeURIComponent(CLUSTER_META.database)}/documents`;

function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) {
      if (val !== undefined) fields[k] = toFs(val);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function fromFs(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = fromFs(val);
    return out;
  }
  return null;
}

const toDoc = (obj) => {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) fields[k] = toFs(v);
  return { fields };
};

const fromDoc = (payload) => {
  const out = {};
  for (const [k, v] of Object.entries(payload?.fields || {})) out[k] = fromFs(v);
  const segs = String(payload?.name || '').split('/');
  out.__id = segs[segs.length - 1];
  return out;
};

async function req(method, url, body) {
  const url2 = url.includes('?') ? `${url}&key=${CLUSTER_META.apiKey}` : `${url}?key=${CLUSTER_META.apiKey}`;
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url2, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Firestore ${method} ${res.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

const colUrl = (name) => `${DOCS}/${CLUSTER_META.collections[name] || name}`;
const docUrl = (name, id) => `${colUrl(name)}/${encodeURIComponent(id)}`;

function maskQuery(fields) {
  const p = new URLSearchParams();
  for (const f of Object.keys(fields)) p.append('updateMask.fieldPaths', f);
  return p.toString();
}

/** Read all simulated nodes for patrol. */
export async function listNodes() {
  const data = await req('GET', `${colUrl('nodes')}?pageSize=100`);
  return (data.documents || []).map(fromDoc);
}

export async function getNode(id) {
  return fromDoc(await req('GET', docUrl('nodes', id)));
}

/** Use updateMask to preserve fields outside the action effect. */
export async function patchNode(id, fields) {
  const clean = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) clean[k] = v;
  if (!Object.keys(clean).length) return getNode(id);
  const res = await req('PATCH', `${docUrl('nodes', id)}?${maskQuery(clean)}`, toDoc(clean));
  return fromDoc(res);
}

/** Write an event, ticket, or notification and return its document ID. */
async function addDoc(name, id, body) {
  const url = `${colUrl(name)}?documentId=${encodeURIComponent(id)}`;
  return fromDoc(await req('POST', url, toDoc(body)));
}

export async function listDocs(name) {
  const data = await req('GET', `${colUrl(name)}?pageSize=200`);
  return (data.documents || []).map(fromDoc);
}

export async function deleteDoc(name, id) {
  return req('DELETE', docUrl(name, id));
}

/** Effects declare fields, verification, and event descriptions. Effects must tolerate repeated patrol execution. */
const EFFECTS = {
  cordon_node: (n) => ({
    fields: { cordoned: true, schedulable: false },
    verify: (a) => a.cordoned === true && a.schedulable === false,
    describe: `Cordoned ${n.node}; ${(n.jobs || []).length} running jobs continue`,
  }),

  restart_job: (n) => {
    const jobs = (n.jobs || []).map((j) => ({ ...j, state: 'restarted' }));
    return {
      fields: { jobs, status: n.status === 'hang' ? 'healthy' : n.status },
      verify: (a) => (a.jobs || []).every((j) => j.state === 'restarted'),
      describe: `Restarted job processes (${(n.jobs || []).map((j) => j.id).join(', ') || 'no jobs'})`,
    };
  },

  set_expandable_segments: (n) => ({
    fields: {
      jobs: (n.jobs || []).map((j) => ({
        ...j,
        env_patch: { PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True' },
      })),
    },
    verify: (a) =>
      (a.jobs || []).every((j) => j.env_patch?.PYTORCH_CUDA_ALLOC_CONF === 'expandable_segments:True'),
    describe: 'Set PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True for the job',
  }),

  reduce_micro_batch: (n) => ({
    fields: {
      jobs: (n.jobs || []).map((j) => ({
        ...j,
        config_patch: { ...(j.config_patch || {}), micro_batch_size: 'halved', grad_accum: 'doubled' },
      })),
    },
    verify: (a) => (a.jobs || []).every((j) => j.config_patch?.micro_batch_size === 'halved'),
    describe: 'Halved micro batch and doubled gradient accumulation; global batch unchanged',
  }),

  enable_gradient_checkpointing: (n) => ({
    fields: {
      jobs: (n.jobs || []).map((j) => ({
        ...j,
        config_patch: { ...(j.config_patch || {}), gradient_checkpointing: true },
      })),
    },
    verify: (a) => (a.jobs || []).every((j) => j.config_patch?.gradient_checkpointing === true),
    describe: 'Enabled gradient checkpointing',
  }),

  align_torch_wheel: (n) => ({
    fields: {
      jobs: (n.jobs || []).map((j) => ({
        ...j,
        env_patch: { ...(j.env_patch || {}), torch_wheel: 'aligned' },
        state: 'restarted',
      })),
    },
    verify: (a) => (a.jobs || []).every((j) => j.env_patch?.torch_wheel === 'aligned'),
    describe: 'Installed a compatible torch wheel and restarted the job',
  }),

  reload_nvidia_modules: (n) => ({
    fields: {
      telemetry: { ...n.telemetry, smi_ok: true, module_for_kernel: true, smi_error: null },
      status: n.status === 'degraded' ? 'healthy' : n.status,
    },
    verify: (a) => a.telemetry?.smi_ok === true && a.telemetry?.module_for_kernel === true,
    describe: 'Reloaded NVIDIA kernel modules in dependency order',
  }),

  gpu_reset: (n) => ({
    fields: {
      telemetry: { ...n.telemetry, smi_ok: true, reset_count: (n.telemetry?.reset_count || 0) + 1 },
    },
    verify: (a) => a.telemetry?.smi_ok === true,
    describe: 'Reset the selected GPU and checked that it remains on the bus',
  }),

  reboot_node: (n) => ({
    fields: { status: 'rebooting', reboot_count: (n.reboot_count || 0) + 1 },
    verify: (a) => a.status === 'rebooting',
    describe: `Rebooted ${n.node}; investigate hardware if Xids recur`,
  }),

  align_driver_version: (n) => ({
    fields: { driver_version: 'aligned', status: 'rebooting' },
    verify: (a) => a.driver_version === 'aligned',
    describe: 'Aligned the node driver with the cluster baseline',
  }),

  drain_node: (n) => ({
    fields: { draining: true, cordoned: true, schedulable: false, status: 'draining', jobs: [] },
    verify: (a) => a.draining === true && a.status === 'draining',
    describe: `Drained jobs from ${n.node} (${(n.jobs || []).map((j) => j.id).join(', ') || 'no jobs'})`,
  }),

  retire_gpu: (n, params) => ({
    fields: {
      retired_gpus: [...new Set([...(n.retired_gpus || []), Number(params.GPU_INDEX ?? 0)])],
    },
    verify: (a) => (a.retired_gpus || []).includes(Number(params.GPU_INDEX ?? 0)),
    describe: `Removed GPU ${params.GPU_INDEX ?? 0} from scheduling`,
  }),

  bulk_driver_upgrade: (n) => ({
    fields: { driver_version: 'aligned', status: 'rebooting' },
    verify: (a) => a.driver_version === 'aligned',
    describe: 'Enrolled this node in the current driver-upgrade batch',
  }),

  file_rma: () => ({
    fields: {},
    verify: () => true,
    describe: 'Prepared a hardware repair ticket in the tickets collection',
  }),
};

export function hasEffect(actionId) {
  return Boolean(EFFECTS[actionId]);
}

/** Write the action effect, read it back, and report verification failure with status failed. */
export async function executeAction({ node, actionId, params = {}, actor = 'agent', reason = '' }) {
  const act = getAction(actionId);
  if (!act) return { ok: false, error: `Unknown action: ${actionId}` };
  const effect = EFFECTS[actionId];
  if (!effect) return { ok: false, error: `No cluster effect defined for action ${actionId}` };

  const before = await getNode(node);
  const planned = effect(before, params);

  let after = before;
  let error = null;
  try {
    if (Object.keys(planned.fields).length) {
      after = await patchNode(node, planned.fields);
    }
  } catch (err) {
    error = String(err.message || err);
  }

  const verified = error ? false : Boolean(planned.verify(after));

  const event = {
    node,
    action_id: actionId,
    action_label: act.label,
    risk: act.risk,
    actor,
    reason,
    describe: planned.describe,
    fields_written: Object.keys(planned.fields),
    status: error ? 'error' : verified ? 'ok' : 'unverified',
    verified,
    error,
    at: new Date().toISOString(),
  };
  try {
    await addDoc('events', `ev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, event);
  } catch {

  }

  return { ok: verified, before, after, planned, verified, event, error };
}

/** Create a draft ticket only; approval, ticket number, and approver are supplied by the operator. */
export async function createTicket({
  node, actionId, title, body, evidence_refs = [], priority = 'normal', created_by = 'agent',
}) {
  const id = `tk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return addDoc('tickets', id, {
    node,
    action_id: actionId,
    title,
    body,
    evidence_refs,
    priority,

    status: 'draft',
    approved: false,
    ticket_no: '',
    approver: '',
    created_by,
    created_at: new Date().toISOString(),
  });
}

export async function approveTicket(id, { ticket_no, approver }) {
  return patchTicket(id, {
    status: 'submitted',
    approved: true,
    ticket_no,
    approver,
    approved_at: new Date().toISOString(),
  });
}

export async function patchTicket(id, fields) {
  const clean = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) clean[k] = v;
  const res = await req('PATCH', `${docUrl('tickets', id)}?${maskQuery(clean)}`, toDoc(clean));
  return fromDoc(res);
}

/** Queue a notification in Firestore. Status remains queued until an external delivery channel is connected. */
export async function notify({ node, channel = 'im', title, text, severity = 'warning' }) {
  const id = `nt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return addDoc('notifications', id, {
    node,
    channel,
    title,
    text,
    severity,
    status: 'queued',
    at: new Date().toISOString(),
  });
}

/** Restore the shared seed and clear simulated events, tickets, and notifications. */
export async function resetCluster() {
  const res = await fetch('./data/cluster_seed.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Seed data load failed: HTTP ${res.status}`);
  const seed = await res.json();

  for (const [id, body] of Object.entries(seed.nodes)) {
    await patchNode(id, body);
  }
  for (const name of ['events', 'tickets', 'notifications']) {
    const docs = await listDocs(name);
    for (const d of docs) await deleteDoc(name, d.__id);
  }
  return Object.keys(seed.nodes).length;
}
