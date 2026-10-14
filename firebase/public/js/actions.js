/**
 * 修复动作库（F11）与审批 / 执行包生成（F12 / F13）。
 *
 * ────────────────────────────────────────────────────────────────────────
 * ★ 这个文件最重要的一条设计：风险等级不从模型来
 * ────────────────────────────────────────────────────────────────────────
 * 每条动作在这里**写死** `risk` 字段。模型能做的只有一件事：把动作的
 * `id` 传进 `propose_fix` 选用它。模型**没有任何途径**声明或修改风险等级，
 * 因此也无法「说服」系统把一个高风险动作降级成低风险、绕过审批。
 *
 * 这和「数字必须来自工具」是同一条纪律在另一个层面上的应用：
 *   数字  → 只能来自工具返回值，模型不能编；
 *   风险  → 只能来自本文件，模型不能改。
 *
 * 如果让模型自由填风险等级，它极可能把「重装驱动」写成低风险——这在
 * 演示现场是致命的，而且这种事在真实生产里天天发生（"就重启一下"）。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 三级风险的判定规则
 * ────────────────────────────────────────────────────────────────────────
 *   低：只影响当前任务进程、可逆、不碰硬件与系统 → 一键批量批准
 *   中：影响节点上其他任务，或需要短暂中断       → 逐条批准 + 勾选影响面
 *   高：不可逆、涉硬件资产、跨节点或影响他人     → 逐条批准 + 变更单号 + 二次确认
 *
 * 判定看的是「爆炸半径」而不是「难不难做」——装个 wheel 可能很麻烦，
 * 但它只影响一个容器，所以是低风险；重启节点只是敲一行命令，但它会杀掉
 * 别人跑了一周的任务，所以是中风险。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 关于命令的诚实声明
 * ────────────────────────────────────────────────────────────────────────
 * 命令按 nvidia-smi / dmesg / modprobe 等**通用工具的标准口径**给出，
 * 不绑定某一种调度器。凡涉及集群平台（K8s、Slurm、自研调度）的部分，
 * 都在 `note` 里明确写了「按你的平台替换」。含 `<尖括号>` 的是待替换参数，
 * 已登记在 `params` 里，界面上会高亮提示。
 *
 * 宁可写清楚「这里有你需要替换的地方」，也不要假装一条命令能通吃所有集群。
 */

// ======================================================================
// 三级风险
// ======================================================================
export const RISK_LEVELS = {
  low: {
    label: '低风险',
    short: '低',
    color: 'green',
    rule: '只影响当前任务进程、可逆、不碰硬件与系统',
    approval: '一键批量批准',
    approval_detail: '可以一次勾选多条一起批准。',
  },
  medium: {
    label: '中风险',
    short: '中',
    color: 'amber',
    rule: '影响节点上其他任务，或需要短暂中断',
    approval: '逐条批准 + 勾选影响面确认',
    approval_detail: '每条单独确认，并勾选「我已确认该节点上的其他任务会被影响」。',
  },
  high: {
    label: '高风险',
    short: '高',
    color: 'red',
    rule: '不可逆、涉及硬件资产、跨节点或影响他人',
    approval: '逐条批准 + 必填变更单号与审批人 + 二次确认',
    approval_detail: '必须填写变更单号与审批人，提交前还需二次确认。',
  },
};

export const RISK_ORDER = ['low', 'medium', 'high'];

// ======================================================================
// 动作库
// ======================================================================
/**
 * 字段说明：
 *   id          模型只能通过这个 id 选用动作
 *   label       动作名
 *   risk        ★ 风险等级，由本文件决定，模型改不了
 *   affects     爆炸半径（界面直接显示，让人在批准前看清影响面）
 *   applies_to  适用于哪些故障分类（用于给界面做推荐，不限制模型选用）
 *   cmds        可直接复制的命令，逐行
 *   params      命令里需要替换的占位符
 *   expect      预期输出——执行完拿什么来验证它真的生效了
 *   rollback    回滚步骤。**为空的动作不允许进执行包**
 *   note        命令的适用范围与坑
 *   source      依据来源；填 kb.js 内部引用或官方 URL，不确定的一律留 null
 */
export const ACTIONS = {
  // ---------------------------------------------------------------- 低风险
  set_expandable_segments: {
    id: 'set_expandable_segments',
    label: '开启显存可扩展段',
    risk: 'low',
    affects: '仅当前任务进程',
    applies_to: ['config'],
    cmds: ['export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True'],
    params: [],
    expect: '重启任务后，torch 不再因显存碎片化抛 OOM；nvidia-smi 的显存曲线更平缓',
    rollback: 'unset PYTORCH_CUDA_ALLOC_CONF，或从启动脚本里删掉这一行，重启任务',
    note: '写进训练启动脚本或容器环境变量，不要只在一个终端里 export（否则换 shell 就丢了）。',
    source: 'https://docs.pytorch.org/docs/stable/notes/cuda.html#environment-variables',
  },
  reduce_micro_batch: {
    id: 'reduce_micro_batch',
    label: '降低 micro batch 并补足梯度累积',
    risk: 'low',
    affects: '仅当前任务进程',
    applies_to: ['config'],
    cmds: [
      '# 把 micro_batch_size 减半，同时把 gradient_accumulation_steps 加倍',
      '# 例：micro_batch_size 8 → 4，gradient_accumulation_steps 4 → 8',
      '# 全局 batch size 不变，训练数学等价，只是显存峰值下降',
    ],
    params: [],
    expect: '单卡显存峰值下降（约与 micro batch 成正比）；单步耗时上升，但全局 batch 不变',
    rollback: '把两个参数改回原值重启任务',
    note: '只要全局 batch size 与学习率不动，训练结果不受影响——这是最安全的降显存手段。',
    source: null,
  },
  enable_gradient_checkpointing: {
    id: 'enable_gradient_checkpointing',
    label: '开启梯度重计算',
    risk: 'low',
    affects: '仅当前任务进程',
    applies_to: ['config'],
    cmds: [
      '# 在模型构建后开启（以 transformers 为例）',
      'model.gradient_checkpointing_enable()',
    ],
    params: [],
    expect: '激活值显存占用大幅下降（引擎估算显示为「重计算」档位）；单步耗时上升约 20–30%',
    rollback: 'model.gradient_checkpointing_disable()，重启任务',
    note: '用时间换显存。交换代价是实打实的，不是免费的——只在上面的手段不够时才动它。',
    source: null,
  },
  restart_job: {
    id: 'restart_job',
    label: '重启任务进程',
    risk: 'low',
    affects: '仅当前任务进程',
    applies_to: ['application', 'config'],
    cmds: [
      'ps -eo pid,ppid,stat,etime,args | grep -E "<TRAIN_CMD>" | grep -v grep',
      '# 确认进程处于 S/R 状态（若为 D 状态，见 process_d_state 相关判断，简单重启无效）',
      'kill -TERM <PID>',
    ],
    params: ['TRAIN_CMD', 'PID'],
    expect: '进程退出，GPU 显存释放（nvidia-smi 里该进程的显存归零）',
    rollback: '重新提交任务即可（这一动作本身不改变任何持久状态）',
    note: 'Xid 43 之后**必须**重启进程：该进程的 CUDA 上下文已经损坏，继续用会一路报错。',
    source: null,
  },
  align_torch_wheel: {
    id: 'align_torch_wheel',
    label: '换成与驱动匹配的 torch wheel',
    risk: 'low',
    affects: '仅当前任务进程',
    applies_to: ['environment'],
    cmds: [
      '# 先看清现状：驱动支持的 CUDA 上限 vs torch 实际编译的 CUDA',
      'nvidia-smi | head -4',
      'python -c "import torch;print(torch.__version__, torch.version.cuda)"',
      '# 装对应 cuXXX 的 wheel（cu121 / cu124 / cu126 按需替换）',
      'pip install --force-reinstall torch --index-url https://download.pytorch.org/whl/cu<CUDA_TAG>',
    ],
    params: ['CUDA_TAG'],
    expect: 'torch.cuda.is_available() 返回 True，且不再报 CUDA driver version is insufficient',
    rollback: 'pip install --force-reinstall torch==<原版本> 装回原 wheel',
    note: '★ 只在**容器内**改，不要动宿主机的驱动。驱动是共用资源，动它会把整台机器上所有人的任务一起带下水。',
    source: null,
  },

  cordon_node: {
    id: 'cordon_node',
    label: '禁止节点接新任务（cordon）',
    risk: 'low',
    affects: '仅影响后续调度，不中断任何正在运行的任务',
    applies_to: ['hardware', 'hardware_watch', 'environment', 'network'],
    cmds: [
      'kubectl cordon <NODE_NAME>',
      '# 非 K8s 调度器：把节点置为 unschedulable / offline，但不驱逐已有任务',
    ],
    params: ['NODE_NAME'],
    expect: '新任务不再被调度到该节点；节点上正在运行的任务不受任何影响',
    rollback: 'kubectl uncordon <NODE_NAME>',
    note: '★ 这是「止损」，不是「驱逐」：cordon 只挡新任务，drain 才赶人。'
      + '面对疑似硬件劣化，正确顺序是**先 cordon、再观察、最后才决定要不要 drain**——'
      + '因为 cordon 完全可逆，而打断别人跑到一半的任务是不可逆的。',
    source: null,
  },

  // ---------------------------------------------------------------- 中风险
  reload_nvidia_modules: {
    id: 'reload_nvidia_modules',
    label: '重载 nvidia 内核模块',
    risk: 'medium',
    affects: '该节点上全部使用 GPU 的任务',
    applies_to: ['environment'],
    cmds: [
      'sudo systemctl stop nvidia-persistenced',
      'sudo rmmod nvidia_uvm nvidia_drm nvidia_modeset nvidia',
      'sudo modprobe nvidia && sudo modprobe nvidia_uvm',
      'nvidia-smi',
    ],
    params: [],
    expect: 'nvidia-smi 恢复正常输出，驱动版本号与实际加载的模块一致',
    rollback: '若模块无法重新加载（rmmod 失败或 modprobe 报错），只能重启节点：sudo reboot',
    note: '★ 卸载顺序不能变（uvm → drm → modeset → nvidia，反向依赖）。'
      + '若 `rmmod` 报 "Module is in use"，说明还有进程占着 GPU，先停任务再试。',
    source: null,
  },
  gpu_reset: {
    id: 'gpu_reset',
    label: '复位指定 GPU',
    risk: 'medium',
    affects: '该节点上正在使用该卡的进程',
    applies_to: ['environment', 'hardware_watch'],
    cmds: ['nvidia-smi -i <GPU_INDEX> -r'],
    params: ['GPU_INDEX'],
    expect: '命令返回 "All done."，且复位后 `nvidia-smi -i <GPU_INDEX>` 仍能列出该卡',
    rollback: '若复位后该卡从 `lspci -d 10de:` 里消失，说明是 PCIe 层故障，复位救不回来：'
      + '需重启节点或直接走报修流程',
    note: '复位要求该卡上没有活动进程。复位本身是安全操作，但它会杀掉卡上残留的僵尸上下文。',
    source: null,
  },
  reboot_node: {
    id: 'reboot_node',
    label: '重启节点',
    risk: 'medium',
    affects: '该节点上全部任务',
    applies_to: ['environment', 'hardware_watch'],
    cmds: ['sudo shutdown -r +1 "GPU maintenance, scheduled reboot"', '# 或按平台的方式排空后重启'],
    params: [],
    expect: '节点重新上线后 Xid 不再复现（若仍复现，指向硬件）',
    rollback: '重启本身无法回滚；执行前请确认节点上任务的断点续训能力',
    note: '重启是「区分软件与硬件」的分水岭动作：重启后消失 → 软件；仍复现 → 硬件方向。'
      + '所以它常常是**必要的诊断步骤**，不要因为它粗暴就跳过。',
    source: null,
  },
  align_driver_version: {
    id: 'align_driver_version',
    label: '对齐节点驱动版本',
    risk: 'medium',
    affects: '该节点上全部任务',
    applies_to: ['environment'],
    cmds: [
      '# 先确认集群的目标版本（以基线节点为准）',
      'nvidia-smi --query-gpu=driver_version --format=csv,noheader | sort -u',
      'sudo apt-get install --allow-downgrades -y nvidia-driver-<TARGET_VERSION>',
      'sudo reboot',
    ],
    params: ['TARGET_VERSION'],
    expect: '该节点的驱动版本与集群基线一致；此前因「同集群不同驱动」导致的 NVML 不一致报错消失',
    rollback: '装回原版本 `nvidia-driver-<原版本>` 并重启',
    note: '★ 混部不同驱动版本是 NVML mismatch 类报错的头号成因。'
      + '升级路径要按平台批量走，不要单点随手升。',
    source: null,
  },
  drain_node: {
    id: 'drain_node',
    label: '驱逐节点上的任务',
    risk: 'medium',
    affects: '该节点上全部任务，且可能影响整作业',
    applies_to: ['hardware', 'hardware_watch', 'environment'],
    cmds: [
      '# K8s：把节点标记为不可调度并驱逐业务 Pod',
      'kubectl drain <NODE_NAME> --ignore-daemonsets --delete-emptydir-data',
      '# 非 K8s 调度器：把节点置为 drained / offline，再手工迁移任务',
    ],
    params: ['NODE_NAME'],
    expect: '节点上不再有新任务被调度进来；原有任务按平台的迁移策略退出或迁移',
    rollback: 'kubectl uncordon <NODE_NAME> 恢复调度',
    note: '驱逐不杀任务，只是让它别再接手新任务。真正的下线动作是后面的 retire_gpu，'
      + '两者分开是为了「先止损、再决定」，不要合并成一步。',
    source: null,
  },

  // ---------------------------------------------------------------- 高风险
  file_rma: {
    id: 'file_rma',
    label: '提交硬件报修（RMA）',
    risk: 'high',
    affects: '硬件资产，涉及采购 / 供应商流程',
    applies_to: ['hardware'],
    cmds: [
      '# 1. 先取卡序列号（工单必填）',
      'nvidia-smi --query-gpu=index,serial,pci.bus_id --format=csv',
      '# 2. 采集完整证据包（含 dmesg / 驱动状态 / ECC 计数）',
      'sudo nvidia-bug-report.sh --safe-mode --output-file /tmp/$(hostname)-gpu<GPU_INDEX>-$(date +%F).tgz',
      '# 3. 把 Xid 历史单独存一份，便于工单里直接贴',
      "sudo dmesg -T | grep -iE 'Xid|NVRM' | tail -200 > /tmp/$(hostname)-xid.log",
      '# 4. 附上以上文件 + 序列号，提交维修工单',
    ],
    params: ['GPU_INDEX'],
    expect: '工单受理并进入换卡流程；该卡在资产系统里标记为维修中',
    rollback: '撤回工单（在供应商接单前）',
    note: '★ 报修是不可逆的资源决策：走一次 RMA，集群就少一块卡、少一份算力。'
      + '所以这个动作只应该由**已确认的硬件故障**触发，不要凭一条 Xid 就提。',
    source: null,
  },
  retire_gpu: {
    id: 'retire_gpu',
    label: '下线该卡',
    risk: 'high',
    affects: '硬件资产，影响集群容量',
    applies_to: ['hardware'],
    cmds: [
      '# 从调度池里摘掉这块卡（具体方式随设备插件而定）',
      '# K8s + NVIDIA device plugin：给节点打标记并排除该卡',
      'kubectl label node <NODE_NAME> nvidia.com/gpu-<GPU_INDEX>=retired --overwrite',
      '# 确认调度器不再把任务派到该卡上',
    ],
    params: ['NODE_NAME', 'GPU_INDEX'],
    expect: '新任务不再被调度到该卡；该卡显存占用归零',
    rollback: '移除该标记（kubectl label node <NODE_NAME> nvidia.com/gpu-<GPU_INDEX>-）',
    note: '下线是「止损」动作，可以在报修之前做——先把坏卡摘出池子，别让它继续接任务。'
      + '标记方式随你的设备插件而变，请按实际平台替换。',
    source: null,
  },
  bulk_driver_upgrade: {
    id: 'bulk_driver_upgrade',
    label: '批量升级节点驱动',
    risk: 'high',
    affects: '整个集群或多个节点',
    applies_to: ['environment'],
    cmds: [
      '# 按批次滚动，不要一次全推',
      '# 1. 先在 1 个非生产节点验证新驱动 + 现有 torch / NCCL 组合',
      '# 2. 分批推送（每批之间留出观测窗口）',
      'ansible-playbook -i inventory upgrade-nvidia-driver.yml --limit batch1',
      '# 3. 每批完成后跑一次冒烟：nvidia-smi + 一次小规模 allreduce',
    ],
    params: [],
    expect: '全集群驱动版本一致；此前跨节点 NVML / NCCL 不一致导致的失败消失',
    rollback: '逐节点回退到上一版驱动（需要预先保留旧驱动包，否则回退会变成停机事故）',
    note: '★ 高风险的来源不是「升级」本身，而是**回退路径可能不存在**。'
      + '执行前必须确认旧驱动包还留着，否则出问题时只能扩大停机。',
    source: null,
  },
};

/**
 * 被系统标记为「不建议」的动作。
 *
 * ★ 保留它、但不放进给模型的候选列表，是这一层最有主见的地方。
 * 知识库（kb.js 的 NCCL 超时条目）已经写明：调大超时是**掩盖问题而非解决问题**——
 * 它让失败从「30 分钟报超时」变成「2 小时报超时」，根因一个都没少，只是发现得更晚。
 *
 * 界面上会把它灰显展示：让人看见系统**知道**有这条路，但选择不推荐它。
 */
export const DISCOURAGED_ACTIONS = {
  raise_nccl_timeout: {
    id: 'raise_nccl_timeout',
    label: '调大集合通信超时',
    risk: 'medium',
    affects: '掩盖症状，问题延后暴露',
    discouraged: true,
    reason: 'NCCL 超时几乎总是**次生现象**——真正断掉的是链路（IB / NVLink / 网卡）或某张卡的性能。'
      + '调大超时不会修好任何一个根因，只会把「30 分钟报错」变成「2 小时报错」，'
      + '让失败发生在更深、更难回滚的位置。',
    instead: '应该先查链路：nvidia-smi nvlink -s、ibstat、以及同批次的 Xid 与 ECC 计数。',
    cmds: ['export NCCL_TIMEOUT=<更大的秒数>', '# 不推荐直接使用'],
    params: [],
    expect: '报错时间推迟，根因不变',
    rollback: '改回原值（但问题不会因此消失）',
    note: '保留此动作是为了让系统能明确地说「这条路我们知道，但不建议」。',
    source: null,
  },
};

export const ACTION_LIST = Object.values(ACTIONS);

const byId = { ...ACTIONS, ...DISCOURAGED_ACTIONS };

/** 按 id 取动作。找不到返回 null——调用方必须处理「模型编了个 id」这种情况。 */
export function getAction(id) {
  return byId[String(id || '').trim()] || null;
}

export function isDiscouraged(id) {
  const a = getAction(id);
  return Boolean(a && a.discouraged);
}

/** 给模型的候选清单：**排除**被标记不建议的动作。 */
export function selectableActions() {
  return ACTION_LIST.map((a) => ({ id: a.id, label: a.label, risk: a.risk, applies_to: a.applies_to }));
}

/**
 * 按故障分类给出推荐动作（界面用）。
 * 这只是「推荐」，不构成对模型选用的限制——模型可以选库里任何一条。
 */
export function suggestActions(classification) {
  if (!classification) return [];
  return ACTION_LIST.filter((a) => a.applies_to.includes(classification));
}

// ======================================================================
// 审批流（F12）
// ======================================================================
/**
 * 把一组待批动作按风险分成三组，交给界面渲染。
 *
 * 分组的意义不只是排版：不同风险级的审批**要求不同**，所以必须分开处理。
 * 低风险可以一次勾选一批；中风险要逐条确认影响面；高风险要填变更单号。
 * 把它们混在一个列表里，就等于把高风险的额外要求给稀释掉了。
 */
export function buildApprovalPlan(actionIds = []) {
  const items = [];
  const unknown = [];

  for (const id of actionIds) {
    const a = getAction(id);
    if (!a) {
      unknown.push(id);
      continue;
    }
    // 没有回滚方案的动作不允许进入审批流——它连执行包都进不去
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

/**
 * 判断一批审批是否满足放行条件。
 *
 * 高风险必须带变更单号与审批人——这条规则写在这里而不是界面里，
 * 因为界面是可以被绕过的，规则不行。
 */
export function validateApproval({ actionIds = [], approvals = {}, ticket = '', approver = '' } = {}) {
  const plan = buildApprovalPlan(actionIds);
  const blocking = [];

  for (const level of RISK_ORDER) {
    const group = plan.groups[level];
    for (const a of group.items) {
      const state = approvals[a.id];
      if (!state || state.decision !== 'approve') continue;

      if (level === 'high') {
        if (!String(ticket).trim()) blocking.push(`${a.label}：高风险动作必须填写变更单号`);
        if (!String(approver).trim()) blocking.push(`${a.label}：高风险动作必须填写审批人`);
      }
      if (level === 'medium' && state.impact_ack !== true) {
        blocking.push(`${a.label}：中风险动作需要勾选确认影响面`);
      }
    }
  }

  return { ok: blocking.length === 0, blocking, plan };
}

// ======================================================================
// 执行包（F13）
// ======================================================================
/**
 * 生成可下载的执行包（Markdown）。
 *
 * 五项内容，缺一不可：
 *   1. 分诊结论与证据链（每条结论指回 T1 / T3 这样的引用编号）
 *   2. 逐条动作 + 可复制命令 + 预期输出
 *   3. 回滚步骤——**没有回滚方案的动作不允许进执行包**
 *   4. 审批记录：谁批的 / 何时 / 变更单号
 *   5. 未获批准的动作明确标注「未批准，请勿执行」
 *
 * 第 3 条和第 5 条是这份文件存在的理由：一份执行包里最危险的东西，
 * 不是写错的命令，而是**没被批准却被执行**的命令。
 */
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

  L.push('# 训练故障分诊 · 执行包');
  L.push('');
  L.push(`生成时间：${stamp}`);
  if (model) L.push(`分诊模型：${model}${mode ? `（${mode}）` : ''}`);
  L.push('');

  // ---- 1 结论
  L.push('## 1. 分诊结论');
  L.push('');
  if (conclusion) {
    L.push(`- 故障分类：**${conclusion.classification_label || conclusion.classification || '未定'}**`);
    if (conclusion.should_rma !== null && conclusion.should_rma !== undefined) {
      L.push(`- 是否需要报修：**${conclusion.should_rma ? '需要（走 RMA）' : '不需要'}**`);
    }
    if (typeof conclusion.confidence === 'number') {
      L.push(`- 置信度：${(conclusion.confidence * 100).toFixed(0)}%`);
    }
    if (conclusion.summary) {
      L.push('');
      L.push(conclusion.summary);
    }
  } else {
    L.push('（本执行包未附带结论摘要）');
  }
  L.push('');

  // ---- 2 证据链
  L.push('## 2. 证据链');
  L.push('');
  if (citations.length) {
    for (const c of citations) {
      const pl = c.payload ? JSON.stringify(c.payload) : '';
      L.push(`- **${c.ref}**｜${c.source}${pl ? `｜${truncate(pl, 220)}` : ''}`);
    }
  } else {
    L.push('（无工具调用记录）');
  }
  if (evidence) {
    L.push('');
    L.push('原始证据包：');
    L.push('```json');
    L.push(truncate(JSON.stringify(evidence, null, 2), 3000));
    L.push('```');
  }
  L.push('');

  // ---- 3 动作
  L.push('## 3. 执行动作');
  L.push('');
  let idx = 0;
  for (const level of RISK_ORDER) {
    const group = plan.groups[level];
    if (!group.items.length) continue;
    L.push(`### ${group.label}（${group.approval}）`);
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
        L.push('> **已拒绝，请勿执行。**');
        L.push('');
        continue;
      }
      if (!approved) {
        L.push('> **未批准，请勿执行。**');
        L.push('');
      }
      L.push(`- 风险等级：${group.label}（${group.rule}）`);
      L.push(`- 影响面：${a.affects}`);
      if (a.params.length) L.push(`- 需替换参数：${a.params.map((p) => `\`<${p}>\``).join('、')}`);
      if (a.note) L.push(`- 注意：${a.note}`);
      if (approved) {
        L.push(`- 审批：${state.decidedAt || '（未记录时间）'}${ticket ? `｜变更单 ${ticket}` : ''}${approver ? `｜审批人 ${approver}` : ''}`);
        if (state.impact_ack) L.push('- 影响面确认：已勾选');
      }
      L.push('');
      L.push('命令：');
      L.push('```bash');
      for (const c of a.cmds) L.push(c);
      L.push('```');
      L.push(`预期输出：${a.expect}`);
      L.push(`回滚：${a.rollback}`);
      L.push('');
    }
  }

  if (!idx) {
    L.push('（本次没有任何动作通过校验，未产出可执行内容）');
    L.push('');
  }

  // ---- 4 不做的事
  L.push('## 4. 系统明确不建议的动作');
  L.push('');
  for (const d of Object.values(DISCOURAGED_ACTIONS)) {
    L.push(`- **${d.label}**（${d.id}）：${d.reason}`);
    if (d.instead) L.push(`  - 应该改为：${d.instead}`);
  }
  L.push('');

  // ---- 5 审批记录
  L.push('## 5. 审批记录');
  L.push('');
  L.push(`- 变更单号：${ticket || '（未填写）'}`);
  L.push(`- 审批人：${approver || '（未填写）'}`);
  const approvedCount = Object.values(approvals).filter((s) => s.decision === 'approve').length;
  const rejectedCount = Object.values(approvals).filter((s) => s.decision === 'reject').length;
  L.push(`- 已批准：${approvedCount} 项｜已拒绝：${rejectedCount} 项`);
  L.push('');
  L.push('---');
  L.push('');
  L.push('> 本执行包由分诊器生成，**不含任何自动执行能力**：'
    + '命令需要人工复制到目标节点执行。高风险动作未经审批不得执行。');

  return L.join('\n');
}

function truncate(s, n) {
  const t = String(s);
  return t.length > n ? `${t.slice(0, n)}…（已截断，共 ${t.length} 字符）` : t;
}

/**
 * 给动作补上审批状态，供界面渲染。
 * 界面只需要读这个结构，不需要自己判断风险等级——等级永远来自库。
 */
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
