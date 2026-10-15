// Local transport fixtures. Application tools, risk gates and rendering run unchanged.
import { readFileSync, writeFileSync } from 'node:fs';

export const RECORDING_MODE = 'local-deterministic-replay';

export function replayOptions(argv) {
  const modes = argv.filter(a => a.startsWith('--mode='));
  if (modes.length !== 1 || modes[0] !== '--mode=replay') {
    throw new Error('This storyboard requires explicit --mode=replay. Live recording is not supported.');
  }
  const urls = argv.filter(a => a.startsWith('--url='));
  if (urls.length > 1) throw new Error('Specify only one loopback --url.');
  const url = new URL(urls[0]?.slice(6) || 'http://127.0.0.1:8908/');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('Replay requires an HTTP loopback URL served from firebase/public.');
  }
  return { url: url.href, recordingMode: RECORDING_MODE };
}

function installReplay(seed) {
  const actualFetch = window.fetch.bind(window);
  const key = '__demoReplayState';
  const fresh = () => ({ cluster: structuredClone(seed.nodes), events: {}, tickets: {}, notifications: {}, audit: { reads: [], writes: [], models: [], unexpected: [] } });
  const state = JSON.parse(localStorage.getItem(key) || 'null') || fresh();
  const save = () => localStorage.setItem(key, JSON.stringify(state));
  const toFs = v => v == null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(toFs) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
  const fromFs = v => 'nullValue' in v ? null : 'booleanValue' in v ? v.booleanValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 'stringValue' in v ? v.stringValue : 'arrayValue' in v ? (v.arrayValue.values || []).map(fromFs) : Object.fromEntries(Object.entries(v.mapValue?.fields || {}).map(([k, x]) => [k, fromFs(x)]));
  const doc = (col, id, value) => ({ name: `projects/local-replay/databases/(default)/documents/${col}/${id}`, fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toFs(v)])) });
  const json = v => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const fc = (name, args) => ({ functionCall: { name, args } });
  window.__demoReplay = { state, doc };
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = (init.method || 'GET').toUpperCase();
    if (url.origin === location.origin) return actualFetch(input, init);
    if (url.hostname === 'firestore.googleapis.com') {
      const [col, rawId] = url.pathname.split('/documents/')[1]?.split('/') || [];
      const id = rawId ? decodeURIComponent(rawId) : url.searchParams.get('documentId');
      if (!state[col]) throw new Error(`Unknown replay collection ${col}`);
      if (method === 'GET') {
        state.audit.reads.push({ col, id }); save();
        return json(id ? doc(col, id, state[col][id]) : { documents: Object.entries(state[col]).map(([id, v]) => doc(col, id, v)) });
      }
      if (!['PATCH', 'POST', 'DELETE'].includes(method)) throw new Error(`Unexpected replay method ${method}`);
      // Mutate the isolated browser profile only; never call actualFetch here.
      state.audit.writes.push({ method, col, id });
      if (method === 'DELETE') delete state[col][id];
      else {
        const value = Object.fromEntries(Object.entries(JSON.parse(init.body).fields).map(([k, v]) => [k, fromFs(v)]));
        state[col][id] = method === 'PATCH' ? { ...state[col][id], ...value } : value;
      }
      save(); return json(method === 'DELETE' ? {} : doc(col, id, state[col][id]));
    }
    if (url.hostname === 'firebasevertexai.googleapis.com' && url.pathname.endsWith(':generateContent')) {
      const payload = JSON.parse(init.body);
      const patrol = payload.tools[0].functionDeclarations.some(t => t.name === 'scan_cluster');
      const turn = payload.contents.filter(c => c.role === 'model').length;
      state.audit.models.push({ mode: patrol ? 'patrol' : 'case', turn }); save();
      await new Promise(r => setTimeout(r, 650));
      let parts;
      if (!patrol) parts = turn === 0 ? [
        fc('lookup_xid', { code: 94 }), fc('lookup_xid', { code: 95 }), fc('inspect_node', { node: 'lyg2103' }),
        fc('propose_fix', { action_id: 'file_rma', title: 'GPU memory deterioration', detail: 'Frequent Xid 94 and rising ECC support hardware escalation.', classification: 'hardware', confidence: 0.95, should_rma: true, evidence_refs: ['T1', 'T2', 'T3'] }),
      ] : [{ text: 'Local replay: the case snapshot supports hardware escalation. The RMA remains a recommendation requiring human approval.' }];
      else {
        const turns = [
          [fc('scan_cluster', {})],
          ['lyg2103', 'lyg2112', 'lyg2115', 'lyg2120'].map(node => fc('inspect_node', { node })),
          [fc('lookup_xid', { code: 94 }), fc('lookup_xid', { code: 62 }), fc('check_compat', {})],
          [fc('propose_fix', { action_id: 'file_rma', title: 'lyg2112: rising ECC', detail: '53 Xid 94 events in 30 days with correctable ECC at 118 and rising. Human review required.', classification: 'hardware', confidence: 0.95, should_rma: true, evidence_refs: ['T1', 'T3', 'T6'] }),
            fc('execute_action', { node: 'lyg2112', action_id: 'cordon_node', reason: 'Frequent Xid 94 and rising correctable ECC. Keep running jobs in place.' }),
            fc('execute_action', { node: 'lyg2115', action_id: 'cordon_node', reason: 'Xid 62 and a blocked process. Prevent new placements.' })],
          [fc('draft_ticket', { node: 'lyg2112', action_id: 'file_rma', title: 'Review lyg2112 GPU memory degradation', body: '53 Xid 94 events in 30 days; correctable ECC 118 and rising. Proposed RMA requires operator approval. Command: nvidia-smi -q -d ECC. No request submitted.', evidence_refs: ['T3', 'T6'] })],
          [fc('notify_operator', { node: 'lyg2112', title: 'RMA approval pending', text: 'Local simulated cordon verified. Review the RMA draft.', severity: 'warning' }), fc('notify_operator', { node: 'lyg2115', title: 'Blocked process requires review', text: 'Local simulated cordon verified. Running jobs continue.', severity: 'warning' }), fc('notify_operator', { node: 'lyg2103', title: 'Monitor isolated Xid 94', text: 'One event in 30 days, flat correctable ECC. No RMA recommended.', severity: 'info' })],
          [fc('inspect_node', { node: 'lyg2112' }), fc('inspect_node', { node: 'lyg2115' })],
        ];
        parts = turns[turn] || [{ text: 'Local deterministic replay complete. lyg2103: hardware_watch, no RMA. lyg2112: hardware escalation recommended. Two simulated cordons verified, one ticket remains draft, three notifications remain queued. No production writes.' }];
      }
      return json({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] });
    }
    state.audit.unexpected.push({ method, url: url.origin + url.pathname }); save();
    throw new Error('External traffic disabled for local deterministic replay');
  };
  document.addEventListener('DOMContentLoaded', () => {
    const tag = document.createElement('div');
    tag.id = 'demo-replay-label';
    tag.textContent = 'LOCAL DETERMINISTIC REPLAY · simulated data · no live model · no external writes';
    tag.style.cssText = 'position:fixed;top:0;left:0;right:0;height:26px;z-index:2147483647;background:#172554;color:white;font:14px Arial;text-align:center;line-height:26px;pointer-events:none';
    document.body.append(tag);
    const header = document.querySelector('header');
    if (header) header.style.top = '26px';
    const clock = document.createElement('span');
    clock.style.cssText = 'position:absolute;right:18px;font:13px monospace'; tag.append(clock);
    setInterval(() => { clock.textContent = new Date().toISOString().slice(11, 23); }, 100);
  });
}

export async function prepareReplay(cdp, appUrl) {
  const origin = new URL(appUrl).origin;
  const externalAttempts = [], transportErrors = [];
  const allowed = url => url.startsWith('data:') || url === 'about:blank' || new URL(url).origin === origin;
  cdp.ws.addEventListener('message', e => {
    const message = JSON.parse(e.data);
    if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params;
      const local = allowed(request.url);
      if (!local) externalAttempts.push(request.url);
      cdp.send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', local ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch(error => transportErrors.push(error.message));
    }
  });
  // Intercept all resource types before navigation; unknown external URLs fail closed.
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  const seed = JSON.parse(readFileSync(new URL('../firebase/public/data/cluster_seed.json', import.meta.url), 'utf8'));
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installReplay.toString()})(${JSON.stringify(seed)});` });
  return async function auditReplay(path) {
    const state = await cdp.eval('window.__demoReplay?.state');
    if (!state) throw new Error('Replay transport was not installed; refusing replay-labelled output.');
    const audit = { recordingMode: RECORDING_MODE, ...state, externalAttempts, transportErrors };
    if (path) writeFileSync(path, JSON.stringify(audit, null, 2));
    console.log('REPLAY_AUDIT ' + JSON.stringify({ reads: state.audit.reads.length, localWrites: state.audit.writes.length, modelFixtures: state.audit.models.length, externalAttempts: externalAttempts.length, unexpected: state.audit.unexpected.length, transportErrors: transportErrors.length }));
    if (externalAttempts.length || state.audit.unexpected.length || transportErrors.length) throw new Error('Unexpected external request or transport failure during replay');
    return audit;
  };
}

export async function showReplayDocument(cdp) {
  await cdp.eval(`(() => {
    if (!window.__demoReplay) throw new Error('Replay state missing');
    const replay = window.__demoReplay;
    const documentValue = replay.doc('cluster', 'lyg2112', Object.fromEntries(['node', 'cordoned', 'schedulable'].map(k => [k, replay.state.cluster.lyg2112[k]])));
    history.pushState({}, '', '/__replay__/cluster');
    for (const child of [...document.body.children]) if (child.id !== 'demo-replay-label') child.remove();
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;font:18px monospace;padding:40px';
    pre.textContent = JSON.stringify({ local_deterministic_replay: true, description: 'Projected Firestore REST document from local simulated state', document: documentValue }, null, 2);
    document.body.append(pre);
  })()`);
}
