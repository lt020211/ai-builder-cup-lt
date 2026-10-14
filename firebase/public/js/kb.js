/**
 * 知识库层：本项目的「事实底座」。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 这个文件为什么单独存在
 * ────────────────────────────────────────────────────────────────────────
 * 分诊器的全部可信度来自一件事：**结论必须能落到一条可核实的事实上**。
 * 所以把所有事实集中在这一个文件里，每条都带 `source` 字段指向权威出处。
 * 模型只能通过工具读到这些事实，读不到就无权下结论——这比写「请勿编造」
 * 的提示词有效得多。
 *
 * 数据来源（均为公开可核实的资料）：
 *   - NVIDIA 官方 Xid 文档           https://docs.nvidia.com/deploy/xid-errors/
 *   - NVIDIA GPU 调试与内存错误管理指南
 *   - 公开的 GPU 集群 RAS 运维知识库
 *   - PyTorch 官方与社区维护的 CUDA 兼容表
 *   - CUDA Toolkit Release Notes（最低驱动版本）
 *
 * 注意：本文件**不包含**任何需要联网才能确认的实时数据。版本矩阵是
 * 截至 2026-10 的快照，`VERSION_MATRIX_UPDATED` 记录了这个时间点。
 */

/** 版本矩阵的快照日期。界面上会显示，避免读者误以为它是实时的。 */
export const VERSION_MATRIX_UPDATED = '2026-10';

// ======================================================================
// 1. 故障分类学
// ======================================================================
/**
 * 六分类是这个项目的核心判别维度——也是它对一线最有价值的地方。
 *
 * 为什么必须把 `application` 和 `hardware` 分开：公开的集群运维资料反复强调
 * 同一件事——**「不要为用户的 bug 去报修一块好卡」**。Xid 13 / 31 / 43
 * 会跟着有 bug 的任务跑，换节点也跟着，但硬件本身是好的。反向的误判同样常见：
 * 把 Xid 94 的累积增长当成「偶发、无所谓」，直到 Xid 95 出现才追悔。
 * 分诊器的第一个任务就是把这条线画准。
 */
export const CLASSES = {
  application: {
    label: '应用 / 代码缺陷',
    short: '应用',
    hint: '改代码即可，不要动硬件',
    action: '定位并修复触发异常的那段 CUDA 代码；换节点不会消失。',
    color: 'blue',
  },
  hardware: {
    label: '硬件故障',
    short: '硬件',
    hint: '需隔离并报修',
    action: '隔离该卡/节点，收集证据后走 RMA 或维修流程。',
    color: 'red',
  },
  hardware_watch: {
    label: '硬件观察项',
    short: '观察',
    hint: '记录趋势，达阈值再处理',
    action: '不立即报修，但要记录发生频次与前后关联事件。',
    color: 'amber',
  },
  environment: {
    label: '环境 / 版本不兼容',
    short: '环境',
    hint: '改环境，别改硬件',
    action: '对齐驱动、CUDA 运行时、框架版本的组合。',
    color: 'purple',
  },
  config: {
    label: '配置 / 资源参数错误',
    short: '配置',
    hint: '改参数即可',
    action: '调整 batch / 序列长度 / 并行度 / 显存策略等运行时参数。',
    color: 'teal',
  },
  network: {
    label: '网络 / 通信',
    short: '网络',
    hint: '查链路与集合通信',
    action: '检查 IB/NVLink 链路、拓扑与 Fabric Manager 状态。',
    color: 'coral',
  },
  undetermined: {
    label: '证据不足',
    short: '存疑',
    hint: '需要补充证据',
    action: '现有证据不足以定位，应补充日志或遥测后重新分诊。',
    color: 'gray',
  },
};

/** 严重程度：决定「先处理哪个」。 */
export const SEVERITY = {
  blocking: { label: '阻断', hint: '任务已失败，必须处理' },
  degrading: { label: '劣化', hint: '任务能跑但结果或性能受影响' },
  watch: { label: '观察', hint: '当前无影响，记录趋势' },
};

// ======================================================================
// 2. Xid 错误码表
// ======================================================================
/**
 * NVIDIA Xid 是驱动检测到 GPU 异常时写进内核日志的错误码。
 *
 * 两个必须记住的性质（这决定了工具怎么用）：
 *   1. Xid **不是累计计数**，而是「最近一次事件的码值」。要拿到历史必须
 *      查 dmesg / journald，只看 DCGM 的 DCGM_FI_DEV_XID_ERRORS 会漏掉上下文。
 *   2. Xid 154 本身不是根因，它只是在告诉你「驱动要求的恢复动作变了」
 *      （Reset / Reboot / Drain），必须结合前序 Xid 一起读。
 */
export const XID_TABLE = {
  13: {
    name: '图形 / 计算引擎异常',
    name_en: 'Graphics Engine Exception',
    class: 'application',
    severity: 'degrading',
    meaning:
      '引擎执行时遇到异常，绝大多数情况是应用代码里的非法内存访问或非法指令。' +
      '这个错误会「跟着任务走」——换节点仍然复现。',
    action: '保留应用错误栈；用 Compute Sanitizer 在最小复现上定位越界/非法指令。',
    rma: false,
    source: 'https://ai-infrastructure.net/reliability-ras',
  },
  31: {
    name: 'GPU 内存页错误（MMU fault）',
    name_en: 'GPU memory page fault',
    class: 'application',
    severity: 'degrading',
    meaning:
      '设备侧访问了未映射的地址，通常是内核里的越界访问。' +
      '同样跟着任务走，不代表硬件坏了。',
    action: '查非法地址访问与关联进程；跑 Compute Sanitizer memcheck 复现。',
    rma: false,
    source: 'https://ai-infrastructure.net/reliability-ras',
  },
  43: {
    name: 'GPU 停止处理（应用触发）',
    name_en: 'GPU stopped processing',
    class: 'application',
    severity: 'blocking',
    meaning:
      '应用触发的软件故障导致相关工作终止。该进程的上下文已损坏，必须重启进程。' +
      '**不要等同于 OOM**，也不要直接判定硬件故障。',
    action: '查看应用日志与前序 Xid；重启任务进程，修复触发异常的代码。',
    rma: false,
    divergence:
      '★ 各权威资料对 Xid 43 的归类**存在分歧**：NVIDIA 运维知识库与阿里云 ACK 官方文档' +
      '都判为「应用自身错误，非硬件问题」；而另一份开源诊断表判为「硬件/驱动，常见于' +
      '严重 ECC 错误之后」。**这不是知识库的缺陷，而是分诊必须存在的原因**——' +
      '遇到 43 必须回查同一时段是否还有 48 / 95 / 79 这类硬指标：有则按硬件处理，无则按应用处理。',
    source: 'https://ai-infrastructure.net/reliability-ras',
  },
  45: {
    name: '因前序错误触发的抢占式清理',
    name_en: 'Preemptive cleanup due to previous error',
    class: 'application',
    severity: 'degrading',
    meaning:
      '运行多个 CUDA 应用时遇到不可纠正错误（DBE）后，驱动抢占式清理上下文。' +
      '这是「前序错误的后果」，本身不是根因。',
    action: '向前查找更早的那条 Xid（通常是 48 或 94/95），那条才是根因。',
    rma: false,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  48: {
    name: '双位 ECC 错误（DBE）',
    name_en: 'Double Bit ECC Error',
    class: 'hardware',
    severity: 'blocking',
    meaning:
      '显存中出现不可纠正错误。会直接杀死任务，并可能触发页退役与 GPU 复位。',
    action:
      '停止受影响工作并检查 63/64/94/95 等关联事件。公开运维经验：' +
      '若一周内复发，即走 RMA。',
    rma: true,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  62: {
    name: '内部微控制器挂起（PMU halt）',
    name_en: 'Internal Micro-controller Halt (PMU_HALT_ERROR)',
    class: 'environment',
    severity: 'degrading',
    meaning:
      'GPU 内部调度器挂起，通常在驱动发生严重竞争或溢出时出现。' +
      '这是「GPU 卡死」在内核侧最常见的证据——训练进程 hang 住不动、' +
      '而 nvidia-smi 显示的利用率却挂在 100%。',
    action:
      '收集驱动与固件版本并按恢复动作处理。**若与 Xid 79 同现或反复出现，' +
      '升级为硬件方向排查。**',
    rma: null,
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-xid-errors',
  },
  63: {
    name: 'ECC 页退役 / 行重映射事件',
    name_en: 'ECC page retirement / row remapping event',
    class: 'hardware_watch',
    severity: 'watch',
    meaning:
      '有坏页被退役（旧卡）或被重映射到备用行（Hopper/Blackwell）。' +
      '**不能解释成「可纠正错误已经完全修好」**，它只是记录了一次事件。',
    action:
      '读取 pending / failure 状态与 ECC 上下文；关注累计趋势而非单次计数。',
    rma: false,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  64: {
    name: 'ECC 页退役 / 行重映射失败',
    name_en: 'ECC page retirement / row remapping failure',
    class: 'hardware',
    severity: 'blocking',
    meaning:
      '重映射失败，意味着备用行已经耗尽。这是明确的硬件劣化信号。',
    action: '限制该资源继续接单，立即升级并按恢复指引处理；不要只累计次数观察。',
    rma: true,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  65: {
    name: 'ECC 模式变更通知',
    name_en: 'ECC mode change notification',
    class: 'hardware_watch',
    severity: 'watch',
    meaning: 'ECC 的工作模式发生了变化。这是通知类事件，本身不代表故障。',
    action: '记录即可，无需立即处置。',
    rma: false,
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-xid-errors',
  },
  69: {
    name: '图形引擎 class 错误',
    name_en: 'Graphics engine class error',
    class: 'application',
    severity: 'degrading',
    meaning: '应用对引擎 API 的误用，属于代码侧问题。',
    action: '检查应用的 API 调用是否越界或传入了非法参数。',
    rma: false,
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-xid-errors',
  },
  74: {
    name: 'NVLink 异常',
    name_en: 'NVLink error',
    class: 'network',
    severity: 'degrading',
    meaning:
      'NVLink 链路出错，会拖慢甚至中断集合通信。多卡同时报错**不等于**应直接重启全部节点。',
    action:
      '同时检查链路两端、拓扑及 NVSwitch / Fabric Manager 日志；必要时降速运行。',
    rma: null,
    source: 'https://ai-infrastructure.net/reliability-ras',
  },
  79: {
    name: 'GPU 从 PCIe 总线上掉线',
    name_en: 'GPU has fallen off the bus',
    class: 'hardware',
    severity: 'blocking',
    meaning:
      '驱动通过 PCI Express 访问 GPU 时发现设备已不可达。常见原因是 PCIe 链路' +
      '硬件故障，也可能由 GPU 硬件故障或驱动问题引起。',
    action:
      '隔离受影响资源，收集 PCIe AER、供电与 BMC 证据；重插/换槽位后仍失败则报修。',
    rma: true,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  92: {
    name: '单比特 ECC 错误率偏高',
    name_en: 'High single-bit ECC error rate',
    class: 'hardware_watch',
    severity: 'watch',
    meaning:
      '可纠正（单比特）ECC 错误的发生率超出正常水平。' +
      '**这是一个前兆指标**：加速上升的 SBE 速率往往先于不可纠正错误（DBE）出现。',
    action:
      '不需立即处置，但**必须做趋势跟踪**——按周观察速率是否在加速，而不是只看绝对值。',
    rma: false,
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-xid-errors',
  },
  93: {
    name: 'InfoROM 写入寿命上限（非致命）',
    name_en: 'Non-fatal violation of provisioned InfoROM wear limit',
    class: 'config',
    severity: 'watch',
    meaning:
      '驱动因 InfoROM 写入次数达到 NVFlash 设定的保护上限而拒绝写入。' +
      '多数情况下不代表驱动或闪存故障，而是保护机制按预期生效。',
    action: '用 nvflash --elsessionclear 清除写入上限；仍失败则上报 NVIDIA。',
    rma: false,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  94: {
    name: '已隔离的内存错误（Contained）',
    name_en: 'Contained ECC error',
    class: 'hardware_watch',
    severity: 'watch',
    meaning:
      '错误被隔离在单个应用内（A100 及之后的卡支持 error containment）。' +
      '遇到该错误的应用需重启，**其余应用不受影响**。偶发的 94 属于硬件自行处理，正常。',
    action:
      '重启受影响应用即可；方便时再复位 GPU。**不要因为偶发 94 就报修。**',
    rma: false,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  95: {
    name: '未隔离的内存错误（Uncontained）',
    name_en: 'Uncontained ECC error',
    class: 'hardware',
    severity: 'blocking',
    meaning:
      '错误跨多个应用扩散，受影响 GPU 必须复位后应用才能重启。' +
      '若伴随 94 的发生频次持续上升，说明劣化已超出隔离能力。',
    action: '复位 GPU；若 94 频次同步上升，判定劣化超限，走 RMA。',
    rma: true,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  109: {
    name: '上下文切换超时',
    name_en: 'Context switch timeout',
    class: 'hardware_watch',
    severity: 'watch',
    meaning:
      '**本身不致命，但它是明确的前兆指标。**公开运维资料指出：它常在更严重错误' +
      '出现前数分钟到数小时内发生，因此应当被当作预警信号，而不是孤立的噪声。',
    action: '不单独处置；向前关联后续 Xid，向后回看该任务是否在数小时内失败。',
    rma: null,
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-xid-errors',
  },
  110: {
    name: '安全故障（Security fault）',
    name_en: 'Security fault error',
    class: 'hardware',
    severity: 'blocking',
    meaning:
      '官方说明：除非存在硬件故障，此事件应当罕见。',
    action: '回退最近的硬件改动并冷复位系统；若无效则联系硬件厂商。',
    rma: true,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  119: {
    name: 'GSP RPC 超时',
    name_en: 'GSP RPC Timeout',
    class: 'environment',
    severity: 'degrading',
    meaning:
      '等待 GPU 的 GSP 核心响应 RPC 消息时超时。指向固件 / 驱动软件栈，' +
      '**不等于机密计算错误，也不等于 HBM 报废**。',
    action: '收集驱动与 GSP 固件版本，按恢复动作处理；持续复现则升级驱动。',
    rma: false,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  120: {
    name: 'GSP 核心错误',
    name_en: 'GSP error',
    class: 'environment',
    severity: 'degrading',
    meaning:
      'GSP 核心上运行的代码出错。与 119 同源，指向固件 / 驱动层。',
    action: 'GPU 复位或节点断电重启；仍复现则按 NVIDIA GPU 调试指南升级驱动/固件。',
    rma: false,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  121: {
    name: 'C2C 链路可纠正错误',
    name_en: 'C2C Link corrected error',
    class: 'hardware_watch',
    severity: 'watch',
    meaning:
      'GPU 与 Grace CPU 之间的 C2C NVLink 连接上出现已纠正错误，由系统纠正，' +
      '**无运行影响**。',
    action: '在可用维护窗口复位 GPU 以重新训练链路。',
    rma: false,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  137: {
    name: 'NVLink FLA 权限错误',
    name_en: 'NVLink FLA privilege error',
    class: 'application',
    severity: 'degrading',
    meaning:
      '远端 MMU 报告故障，例如非法的 NVLink 点对点访问。通常是应用层 bug，' +
      '也可能是驱动或硬件 bug。',
    action:
      '用 cuda-gdb 或 Compute Sanitizer memcheck 复现；或用 ' +
      'CUDA_DEVICE_WAITS_ON_EXCEPTION=1 后挂调试器。',
    rma: null,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  140: {
    name: 'ECC 不可恢复错误',
    name_en: 'ECC unrecovered error',
    class: 'hardware',
    severity: 'blocking',
    meaning:
      '显存中出现不可纠正错误，且干扰了驱动的动态页下线 / 行重映射能力。',
    action: '复位 GPU；若问题持续，联系硬件厂商支持。',
    rma: true,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  154: {
    name: 'GPU 恢复动作发生变化',
    name_en: 'GPU recovery action changed',
    class: 'hardware',
    severity: 'degrading',
    meaning:
      '**它本身不是根因**。这条事件在告诉你驱动要求的恢复动作升级了：' +
      'Reset / Reboot / Drain 之一。必须结合前序 Xid 一起读。',
    action: '按消息要求执行对应恢复动作，并回查触发它的前序 Xid。',
    rma: null,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
};

// ======================================================================
// 2.5 诊断原则
// ======================================================================
/**
 * 这几条比任何单个错误码都重要。
 *
 * 为什么单列：错误码是「事实」，原则是「怎么读事实」。一线误判绝大多数不是
 * 因为不认识某个码，而是因为违反了下面某一条——尤其是「首发原则」和
 * 「症状 ≠ 根因」。提示词里会强制模型先复述相关原则再下结论。
 */
export const DIAGNOSTIC_PRINCIPLES = [
  {
    id: 'first_event',
    title: '首发原则（T0）',
    detail:
      '日志里爆发大量 Xid 时，必须先定位**时间最早的那一条（T0）**。' +
      '后面那些往往只是它的连锁反应——从中间任意一条入手，都会追错根因。',
    source:
      'https://github.com/openeuler-mirror/witty-diagnosis-agent/blob/master/skills/offline-GPU-fault-diagnosis/references/XID_error_codes.md',
  },
  {
    id: 'causal_chain',
    title: '因果关联：次生事件不是根因',
    detail:
      'Xid 31 → 43 常见于显存故障导致卡停止；Xid 48 → 45 表示不可纠正错误引发了抢占式清理。' +
      'Xid 45 与 154 尤其危险——它们**只描述后果**，把它们当根因会一路查错方向。',
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-xid-errors',
  },
  {
    id: 'symptom_vs_cause',
    title: '症状 ≠ 根因',
    detail:
      '同一句报错可以对应完全不同的根因。例如「nvidia-smi 无法与驱动通信」有五种常见成因：' +
      '内核升级后模块未重编 / Secure Boot 拦截未签名模块 / 驱动包未带 DKMS 模块 / ' +
      '装错模块变体（把 nvidia-open 装在老卡上）/ **GPU 掉出 PCIe 总线**。' +
      '只有最后一种是硬件故障，而它的修法与其他四种完全不同。',
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-couldnt-communicate-with-driver',
  },
  {
    id: 'trend_over_snapshot',
    title: '趋势优先于快照',
    detail:
      '单次事件往往无害（例如偶发的 Xid 94），**速率变化才是信号**。' +
      '判断「偶发观察」还是「劣化超限」，依据是 30 天频次走势与可纠正 ECC 是否同步上升。',
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-xid-errors',
  },
  {
    id: 'dont_conflate',
    title: '不要把相似报错混为一谈',
    detail:
      '「NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver」与' +
      '「Failed to initialize NVML: Driver/library version mismatch」外观相似，' +
      '但成因与修法完全不同。公开资料明确提醒**不要把两者混淆**。',
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-couldnt-communicate-with-driver',
  },
  {
    id: 'no_rma_for_app_bugs',
    title: '应用故障不要走报修',
    detail:
      'Xid 13 / 31 / 43 会「跟着有 bug 的任务走」——换节点仍然复现，而硬件本身是好的。' +
      '为这类问题走 RMA，代价是一块好卡被下线、集群容量白掉。',
    source: 'https://ai-infrastructure.net/reliability-ras',
  },
];

// ======================================================================
// 3. 故障特征库
// ======================================================================
/**
 * 非 Xid 类的报错特征。每条给出「典型根因 + 该核实什么」，但不给最终结论——
 * 最终分类要结合节点遥测与版本栈一起判断。
 *
 * `class_hint` 是**默认倾向**，不是结论。工具返回时会明确标注这是 hint。
 */
export const FAILURE_SIGNATURES = [
  {
    id: 'cuda_oom',
    label: 'CUDA 显存不足',
    class_hint: 'config',
    patterns: [/CUDA out of memory/i, /torch\.cuda\.OutOfMemoryError/i],
    root_cause:
      '显存不足以完成本次分配。可能是 batch/序列长度过大、并行度配置与卡数不匹配、' +
      '或存在显存泄漏。',
    check: [
      '用 estimate_memory 核算该模型在该 batch/seq/并行度下的理论需求',
      '对比报错文本里的「总容量」与「已分配/已保留」两个数字',
      '确认是否设置了梯度检查点（gradient checkpointing）',
    ],
    typical_fix: [
      '降低 batch size 或序列长度',
      '开启梯度检查点 / 激活重计算',
      '调整张量并行度或换用更大显存的卡型',
    ],
    source: 'https://pytorch.org/docs/stable/notes/cuda.html',
  },
  {
    id: 'cuda_oom_fragmentation',
    label: '显存碎片导致的分配失败',
    class_hint: 'config',
    patterns: [
      /reserved (?:but )?unallocated/i,
      /GPU \d+ has a total capacity of .* of which .* is free/i,
    ],
    root_cause:
      '已保留但未分配的显存足够，却凑不出一块连续空间——典型的内存碎片，' +
      '而非显存总量不足。',
    check: [
      '报错文本中 free 与 reserved-but-unallocated 的差值',
      '是否在长跑任务里做过不同形状的临时分配',
    ],
    typical_fix: [
      '设置 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True',
      '重启进程释放碎片化池',
    ],
    source: 'https://pytorch.org/docs/stable/notes/cuda.html#memory-management',
  },
  {
    id: 'illegal_memory_access',
    label: '非法内存访问',
    class_hint: 'application',
    patterns: [
      /an illegal memory access was encountered/i,
      /CUDA error: misaligned address/i,
    ],
    root_cause:
      '设备侧发生了越界或错位访问，属于应用代码缺陷。**换节点不会消失。**' +
      '可能同时伴随 Xid 13 或 Xid 31——那两条也是同一件事的表征。',
    check: [
      '报错前最后一个 forward/backward 调用的输入形状',
      '是否存在自定义 CUDA kernel 或第三方算子的索引越界',
    ],
    typical_fix: [
      '用 Compute Sanitizer memcheck 最小复现定位越界',
      '对可疑算子先关闭融合、退回 eager 模式验证',
    ],
    source: 'https://ai-infrastructure.net/reliability-ras',
  },
  {
    id: 'device_side_assert',
    label: '设备侧断言触发',
    class_hint: 'application',
    patterns: [/device-side assert triggered/i, /CUDA error: device-side assert/i],
    root_cause:
      '设备代码里的断言失败，最常见来源是分类任务中标签索引越界' +
      '（标签数大于类别数），或 loss 收到非法输入。',
    check: [
      '用 CUDA_LAUNCH_BLOCKING=1 重跑，让报错停在真正的出错算子',
      '核对数据集标签取值范围与模型输出维度',
    ],
    typical_fix: ['修正标签映射与越界索引', '在 loss 前加输入合法性校验'],
    source: 'https://pytorch.org/docs/stable/notes/cuda.html',
  },
  {
    id: 'nccl_timeout',
    label: 'NCCL 集合通信超时',
    class_hint: 'network',
    patterns: [
      /Watchdog caught collective operation timeout/i,
      /NCCL.*(?:unhandled|timeout|timed out)/i,
      /ProcessGroupNCCL.*timed out/i,
    ],
    root_cause:
      '某个 rank 在集合通信中超时未响应。根因分布很广：可能是网络/链路问题，' +
      '可能是某个 rank 的 GPU 卡住（硬件劣化），也可能是某个 rank 在 CPU 侧' +
      '做了过长的同步操作。**必须结合节点侧 Xid 才能定性。**',
    check: [
      '用 lookup_xid 检查同节点同时段的 Xid 事件',
      '确认超时的是哪个 rank，该 rank 所在节点是否有硬件事件',
      '排除数据加载 / CPU 侧阻塞导致的伪超时',
    ],
    typical_fix: [
      '先在超时节点上排查硬件事件，再考虑调大 NCCL_TIMEOUT',
      '**不要**通过调大超时来掩盖硬件问题',
    ],
    source: 'https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/troubleshooting.html',
  },
  {
    id: 'driver_too_old',
    label: 'NVIDIA 驱动版本过旧',
    class_hint: 'environment',
    patterns: [
      /NVIDIA driver on your system is too old/i,
      /found version \d{5}/i,
      /CUDA driver version is insufficient for CUDA runtime version/i,
    ],
    root_cause:
      '驱动版本低于该 CUDA 运行时要求的最低版本。报错里的数字是驱动版本，' +
      '格式为「.」的位置被去掉（如 11040 表示 11.4）。',
    check: [
      '用 check_compat 核对 driver / cuda_runtime / torch 三者是否自洽',
      '注意：nvidia-smi 显示的 CUDA 版本是驱动「支持上限」，不代表装了这个 Toolkit',
    ],
    typical_fix: ['把驱动升到该 CUDA 版本的最低要求之上', '或改用与该驱动匹配的框架版本'],
    source: 'https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html',
  },
  {
    id: 'libcudart_missing',
    label: 'CUDA 运行库缺失',
    class_hint: 'environment',
    patterns: [
      /libcudart\.so[\.\d]*: cannot open shared object file/i,
      /libcublas\.so[\.\d]*: cannot open shared object file/i,
      /ImportError: libnvrtc/i,
    ],
    root_cause:
      '动态链接器找不到 CUDA 运行库。常见于基础镜像未包含运行时，' +
      '或 pip 装的 torch 与容器内 CUDA 大版本不匹配。',
    check: ['检查 LD_LIBRARY_PATH 与容器内实际存在的 .so 版本号', '核对 torch 的 CUDA 后缀与镜像'],
    typical_fix: ['安装对应 CUDA 运行库或换成 NGC 基础镜像', '让 torch 的 cu 后缀与镜像一致'],
    source: 'https://docs.nvidia.com/cuda/cuda-installation-guide-linux/',
  },
  {
    id: 'no_kernel_image',
    label: '无匹配的 GPU 架构内核镜像',
    class_hint: 'environment',
    patterns: [
      /no kernel image is available for execution on the device/i,
      /CUDA error: no kernel image/i,
    ],
    root_cause:
      '编译出的 CUDA 内核不包含当前 GPU 的架构（sm_XX）。例如用只编了 sm_80 的算子' +
      '去跑 Hopper（sm_90）。',
    check: ['确认 TORCH_CUDA_ARCH_LIST 与实际卡型的计算能力', '确认预编译 wheel 支持的架构列表'],
    typical_fix: ['按目标卡型重新编译或换用带对应架构的 wheel', '设置正确的 TORCH_CUDA_ARCH_LIST'],
    source: 'https://docs.nvidia.com/cuda/cuda-compiler-driver-nvcc/',
  },
  {
    id: 'nccl_version_mismatch',
    label: 'NCCL 版本不一致',
    class_hint: 'environment',
    patterns: [/NCCL version mismatch/i, /ncclInvalidUsage/i, /NCCL internal error/i],
    root_cause: '各节点或各进程链接的 NCCL 版本不一致，集合通信无法协商。',
    check: ['用 check_compat 对比各节点的 nccl 版本', '确认是否混用了镜像 / conda 环境'],
    typical_fix: ['统一所有节点的镜像与 NCCL 版本'],
    source: 'https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/troubleshooting.html',
  },
  {
    id: 'bus_error',
    label: '总线错误 / 掉卡',
    class_hint: 'hardware',
    patterns: [/Bus error/i, /fallen off the bus/i],
    root_cause:
      '进程收到 SIGBUS，通常伴随 Xid 79（GPU 从 PCIe 掉线）。指向 PCIe 链路、' +
      '供电或 GPU 硬件本身。',
    check: ['用 inspect_node 检查该节点同时段的 Xid 事件', '查 PCIe AER 与 BMC 电源事件'],
    typical_fix: ['隔离节点；重插/换槽位后仍失败则报修'],
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  {
    id: 'segfault',
    label: '段错误',
    class_hint: 'undetermined',
    patterns: [/Segmentation fault/i, /SIGSEGV/i],
    root_cause:
      '进程访问了非法地址。可能是应用 bug，也可能是硬件/通信栈异常导致的次生现象。' +
      '**单凭这一行无法定性。**',
    check: [
      '查同节点同时段的 Xid 事件（尤其 79 / 48 / 95）',
      '确认是否可以稳定复现；偶发指向硬件，稳定复现指向代码',
    ],
    typical_fix: ['先用内核 coredump 定位崩溃栈，再决定方向'],
    source: 'https://ai-infrastructure.net/reliability-ras',
  },
  {
    id: 'ib_link',
    label: 'InfiniBand 链路异常',
    class_hint: 'network',
    patterns: [/ibv_|IBV_|failed to open ib device/i, /RoCE|link down.*ib/i],
    root_cause: 'IB / RoCE 链路不可用或降速，会直接表现为集合通信超时。',
    check: ['查 Fabric Manager 与 fabricmanager.log', '确认链路速率与 symbol error 计数'],
    typical_fix: ['隔离受影响端口并排查线缆 / 交换机'],
    source: 'https://docs.nvidia.com/networking/',
  },
  {
    id: 'device_mismatch',
    label: '张量设备不一致',
    class_hint: 'application',
    patterns: [
      /Expected all tensors to be on the same device/i,
      /Expected object of device type/i,
    ],
    root_cause: '参与同一运算的张量分布在不同的 device 上，属于模型代码问题。',
    check: ['检查模型中硬编码的 cuda:0 与多卡支持', '检查 loss 与 label 是否都在同一 device'],
    typical_fix: ['统一用 model.device 推导设备，避免硬编码 device index'],
    source: 'https://pytorch.org/docs/stable/notes/cuda.html',
  },
  {
    id: 'unhandled_cuda_error',
    label: '未处理的 CUDA 错误',
    class_hint: 'undetermined',
    patterns: [/CUDA error: unhandled error/i, /RuntimeError: CUDA error/i],
    root_cause:
      'CUDA 运行时返回了未分类错误。**这条文本本身几乎不携带信息量**，' +
      '真正的线索在同一时段的内核日志里。',
    check: ['用 inspect_node 拉取同节点同时段的 Xid 连续事件', '用 CUDA_LAUNCH_BLOCKING=1 重跑定位'],
    typical_fix: ['先取证再定性，不要按字面猜'],
    source: 'https://ai-infrastructure.net/reliability-ras',
  },
  {
    id: 'oom_host',
    label: '主机内存不足',
    class_hint: 'config',
    patterns: [
      /Cannot allocate memory/i,
      /Out of memory: Killed process.*python/i,
      /bus error.*host/i,
    ],
    root_cause:
      '主机侧内存耗尽，进程被 OOM Killer 终止。常见于 DataLoader worker 过多、' +
      '或把大张量留在 CPU 上。',
    check: ['查 dmesg 里的 OOM Killer 记录', '检查 DataLoader num_workers 与 pin_memory'],
    typical_fix: ['减少 DataLoader worker 数', '把不需要 CPU 副本的张量及时释放'],
    source: 'https://pytorch.org/docs/stable/data.html',
  },
  {
    id: 'ckpt_shape_mismatch',
    label: '检查点形状不匹配',
    class_hint: 'config',
    patterns: [
      /size mismatch for/i,
      /Error\(s\) in loading state_dict/i,
      /Missing key\(s\) in state_dict/i,
    ],
    root_cause: '恢复训练时模型结构与检查点不一致，通常是改了并行度或模型配置后直接续跑。',
    check: ['对比检查点与当前模型的 state_dict 键名和形状', '确认并行度变更后是否做了权重切分/合并'],
    typical_fix: ['按新并行度重新切分检查点', '或先加载可匹配的部分再微调'],
    source: 'https://pytorch.org/docs/stable/generated/torch.load.html',
  },

  // ---------------- 驱动层与设备层（症状相似、根因跨度最大的一组） ----------------
  {
    id: 'smi_cannot_communicate',
    label: 'nvidia-smi 无法与驱动通信',
    class_hint: 'environment',
    patterns: [
      /NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver/i,
      /couldn't communicate with the NVIDIA driver/i,
    ],
    root_cause:
      '用户态（NVML）到内核模块的链路断了。**至少有五种完全不同的成因**：' +
      '① 内核升级后 NVIDIA 模块没为当前内核重编；② Secure Boot 拦下了未签名模块；' +
      '③ 装了驱动包但 DKMS 模块缺失；④ 在 Maxwell/Pascal/Volta 老卡上装了 nvidia-open 变体；' +
      '⑤ **GPU 已掉出 PCIe 总线（Xid 79）**。前四种重装/重编即可，第五种是硬件故障，' +
      '重装驱动也修不好。',
    check: [
      'dmesg -T | grep -i nvrm —— 找模块加载失败或 Xid 79',
      'lsmod | grep nvidia 看内核模块是否加载',
      'dkms status 与 uname -r 比对，确认模块是否为当前内核编译',
      'mokutil --sb-state 看 Secure Boot 是否开启',
      'lspci -d 10de: 看 GPU 是否还在 PCI 总线上（不在 = 掉卡）',
    ],
    typical_fix: [
      '先确认不是 Xid 79：如果是掉卡，走硬件流程而不是重装驱动',
      '否则按内核模块问题处理：重建 DKMS 模块或重启',
    ],
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-couldnt-communicate-with-driver',
  },
  {
    id: 'nvml_mismatch',
    label: 'NVML 驱动/库版本不匹配',
    class_hint: 'environment',
    patterns: [
      /Failed to initialize NVML:\s*Driver\/library version mismatch/i,
      /NVML library version:/i,
    ],
    root_cause:
      '用户态驱动包被升了，但内核里仍是旧模块——通常是一次**半完成的自动升级**造成的' +
      '（例如 unattended-upgrade 只换了一部分包）。',
    check: [
      'NVRM: API mismatch 那行的两个版本号分别是多少',
      '是否刚发生过内核升级或包自动更新',
      '有没有重启过（重启后新旧版本会同步）',
    ],
    typical_fix: [
      '重启节点即可加载新内核模块（最省事）',
      '或按顺序卸载模块 uvm → drm → modeset → nvidia 后重装 DKMS',
      '长效机制：把 nvidia-* 加入自动升级黑名单，避免再次半升级',
    ],
    source: 'https://ubuntu.com/desktop/docs/en/latest/how-to/graphics/troubleshoot-nvidia/',
  },
  {
    id: 'nvrm_api_mismatch',
    label: '内核模块与用户态组件版本不一致（API mismatch）',
    class_hint: 'environment',
    patterns: [
      /NVRM:\s*API mismatch:\s*the client has the version/i,
      /this kernel module has the version/i,
    ],
    root_cause:
      '日志会直接给出两个版本号：client（用户态）与 kernel module（内核态）。' +
      '这是 nvml_mismatch 的内核侧证据，两者通常是同一件事。',
    check: ['读出日志里的两个版本号并对比', '确认升级是何时发生的、是否重启过'],
    typical_fix: ['重启使内核模块与用户态对齐；随后把 nvidia-* 排除出自动升级'],
    source: 'https://somaz.blog/category/troubleshooting/nvidia-driver-library-mismatch-resolution/',
  },
  {
    id: 'smi_no_devices',
    label: 'nvidia-smi 报找不到设备',
    class_hint: 'environment',
    patterns: [/No devices were found/i, /no NVIDIA GPU found/i],
    root_cause:
      '常见于开源的 nouveau 驱动被预装并占用，与专有驱动冲突；也可能确实是设备未上电或未识别。',
    check: ['lsmod | grep nouveau 确认冲突驱动是否加载', 'lspci | grep -i nvidia 看设备是否被系统识别'],
    typical_fix: ['把 nouveau 加入 blacklist 并重建 initramfs 后重启'],
    source: 'https://ubuntu.com/desktop/docs/en/latest/how-to/graphics/troubleshoot-nvidia/',
  },
  {
    id: 'cuda_devices_busy',
    label: '所有 CUDA 设备忙或不可用',
    class_hint: 'undetermined',
    patterns: [
      /all CUDA-capable devices are busy or unavailable/i,
      /cudaErrorDevicesUnavailable/i,
    ],
    root_cause:
      '设备被独占占用，或驱动层已异常。**单凭这一行无法定性**：' +
      '可能只是别的进程占满了卡，也可能是驱动/硬件异常的早期表现。',
    check: [
      '用 inspect_node 看该节点同时段有无 Xid 事件',
      'nvidia-smi 查是否有其他进程占用设备',
      '检查容器的 visible devices 配置',
    ],
    typical_fix: ['先排除占用与配置问题，再考虑驱动或硬件方向'],
    source: 'https://docs.nvidia.com/deploy/nvml-api/',
  },
  {
    id: 'rm_init_adapter_failed',
    label: '驱动初始化适配器失败',
    class_hint: 'undetermined',
    patterns: [/RmInitAdapter failed/i, /rm_init_adapter failed/i, /NVRM:.*RmInitAdapter/i],
    root_cause:
      '内核模块无法完成对 GPU 的初始化。可能是模块变体装错、固件异常，' +
      '**也可能是 GPU 已不在总线上**。',
    check: ['从日志里找前置的 Xid（79 / 119 / 120）', '确认该 GPU 是否还在 lspci 输出里'],
    typical_fix: ['有前置 Xid 则按该 Xid 处理；无前置 Xid 则按驱动/固件方向排查'],
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-couldnt-communicate-with-driver',
  },
  {
    id: 'secure_boot_block',
    label: '内核模块被拒载（签名/锁定）',
    class_hint: 'environment',
    patterns: [
      /module verification failed/i,
      /Lockdown:\s*.*(?:unsigned|signature)/i,
      /Key was rejected by service/i,
    ],
    root_cause:
      'Secure Boot 开启但未注册机器所有者密钥（MOK），内核拒绝加载未签名的 NVIDIA 模块。' +
      '常在新装驱动或内核升级使签名失效后出现。',
    check: ['mokutil --sb-state 确认 Secure Boot 状态', 'dmesg 里找 module verification / lockdown 记录'],
    typical_fix: ['为模块签名并注册 MOK，或在可控集群中关闭 Secure Boot'],
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-couldnt-communicate-with-driver',
  },

  // ---------------- GPU 卡死（hang） ----------------
  {
    id: 'gpu_hang_no_progress',
    label: 'GPU 卡死：利用率满但无进展',
    class_hint: 'undetermined',
    patterns: [
      /GPU hang/i,
      /GPU stopped processing/i,
      /hang detected/i,
      /kernel.*timeout.*GPU/i,
    ],
    root_cause:
      'GPU 停止推进工作——表现是利用率挂在 100% 但 loss / 进度长时间不更新，' +
      '或 nvidia-smi 查询本身开始变慢。**这是最需要分诊的症状**：' +
      '可能来自应用死锁、驱动/GSP 异常、NVLink 通信挂死，也可能是硬件挂死的前兆。' +
      '**必须结合内核 Xid 与进程状态才能定性。**',
    check: [
      '查同节点同时段的 Xid（尤其 62 / 43 / 79 / 74 / 119）',
      '查相关进程是否处于 D 状态（uninterruptible sleep）',
      '确认是所有 rank 都卡住，还是只有部分 rank 卡住',
      '区分「整个任务无输出」与「某个 rank 无输出」——后者指向单卡问题',
    ],
    typical_fix: [
      '有 Xid 62 / 79 等内核侧证据 → 按驱动或硬件方向处理',
      '无任何 Xid、只有 NCCL/应用栈报错 → 按应用方向排查（如 rank 间不同步、死循环 kernel）',
      '**不要用调大超时来掩盖它**',
    ],
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-xid-errors',
  },
  {
    id: 'smi_itself_hangs',
    label: 'nvidia-smi 命令本身卡住',
    class_hint: 'hardware',
    patterns: [/nvidia-smi.*(?:hang|freeze|stuck|timed out)/i, /执行\s*nvidia-smi\s*超时/i],
    root_cause:
      '连查询工具都无法完成 IOCTL。**这比「报错退出」更严重**——说明 GPU 已不能正常响应驱动，' +
      '通常指向设备挂死而非上层软件问题。',
    check: ['用 timeout 5 nvidia-smi 确认确实无响应而非慢', '查 dmesg 有无 Xid 62 / 79', '检查进程是否处于 D 状态'],
    typical_fix: [
      '尝试单卡复位 nvidia-smi --gpu-reset -i N（需先释放占用）',
      '复位失败则隔离该卡并走硬件流程',
    ],
    source: 'https://help.aliyun.com/zh/ack/ack-managed-and-ack-dedicated/user-guide/use-node-diagnosis-to-self-troubleshoot-gpu-node-problems',
  },
  {
    id: 'gpu_reset_failed',
    label: 'GPU 复位失败',
    class_hint: 'hardware',
    patterns: [
      /Unable to reset the GPU/i,
      /In use by another client/i,
      /GPU reset.*(?:failed|not supported)/i,
    ],
    root_cause:
      '复位失败可能是「有进程仍占用设备」（可解决），也可能是「复位本身不成功」——' +
      '后者说明挂死已经超出软件恢复能力。',
    check: ['先确认是否还有进程占用该卡（nvidia-smi 或 lsof /dev/nvidia*）', '查复位后的 Xid 是否继续出现'],
    typical_fix: ['先释放占用再复位；仍失败则隔离节点走硬件流程'],
    source: 'https://help.aliyun.com/zh/ack/ack-managed-and-ack-dedicated/user-guide/use-node-diagnosis-to-self-troubleshoot-gpu-node-problems',
  },
  {
    id: 'process_d_state',
    label: '进程处于 D 状态且无法终止',
    class_hint: 'hardware',
    patterns: [
      /\bD\s+state\b/i,
      /\bD</i,
      /uninterruptible sleep/i,
    ],
    root_cause:
      '进程进入不可中断睡眠，说明它正阻塞在一次无法返回的内核操作上（通常是显卡驱动或存储 IO）。' +
      '**`kill -9` 对它无效是典型特征**——阻塞在内核态，信号无法投递。',
    check: [
      'ps -eo pid,ppid,stat,wchan,etime,args | awk \'$4~/^D/\' 找 D 状态进程',
      'cat /proc/PID/stack 看内核栈，确认阻塞在哪个驱动上',
      '查同节点 Xid 事件',
    ],
    typical_fix: [
      '阻塞在 nvidia 驱动 → 按 GPU 挂死方向处理，必要时重启节点',
      '阻塞在存储 → 属另一类问题（元数据/后端拥塞），不要误判为 GPU 故障',
    ],
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-couldnt-communicate-with-driver',
  },
];

// ======================================================================
// 4. 兼容矩阵
// ======================================================================
/** PyTorch 版本 → 官方预编译 wheel 支持的 CUDA 版本。 */
export const TORCH_CUDA = {
  '2.9': ['12.8', '12.9', '13.0'],
  '2.8': ['12.6', '12.8', '12.9'],
  '2.7': ['11.8', '12.6', '12.8'],
  '2.6': ['11.8', '12.4', '12.6'],
  '2.5': ['11.8', '12.1', '12.4'],
  '2.4': ['11.8', '12.1', '12.4'],
  '2.3': ['11.8', '12.1'],
  '2.2': ['11.8', '12.1'],
  '2.1': ['11.8', '12.1'],
  '2.0': ['11.7', '11.8'],
};

/**
 * CUDA Toolkit 版本 → Linux x86_64 上的最低驱动版本。
 *
 * 这条关系是最容易踩的坑之一：**nvidia-smi 右上角显示的 CUDA 版本是驱动
 * 「支持到哪个版本」，不是「装了哪个版本」**。反过来，驱动低于下表值时，
 * 对应 CUDA 运行时根本无法启动。
 *
 * 另有 minor version compatibility：满足 CUDA 12.0 最低要求的驱动理论上能跑
 * 整个 CUDA 12.x，但会失去部分特性，且 PyTorch 自身的检查更严格，实践中
 * 经常直接报 is_available() == False。所以本工具按「严格模式」判定，并注明。
 */
export const CUDA_DRIVER_MIN = {
  '11.7': '450.80.02',
  '11.8': '520.61.05',
  '12.0': '525.60.13',
  '12.1': '530.30.02',
  '12.2': '535.54.03',
  '12.3': '545.23.06',
  '12.4': '550.54.14',
  '12.5': '555.42.02',
  '12.6': '560.28.03',
  '12.8': '570.26',
  '12.9': '575.51.03',
};

/** 驱动的 CUDA 支持上限（driver major series → 最高 CUDA）。用于反向校验。 */
export const DRIVER_CUDA_CEILING = [
  { driver_min: '570.00', cuda: '12.9' },
  { driver_min: '560.00', cuda: '12.6' },
  { driver_min: '555.00', cuda: '12.5' },
  { driver_min: '550.00', cuda: '12.4' },
  { driver_min: '545.00', cuda: '12.3' },
  { driver_min: '535.00', cuda: '12.2' },
  { driver_min: '530.00', cuda: '12.1' },
  { driver_min: '525.00', cuda: '12.0' },
  { driver_min: '520.00', cuda: '11.8' },
  { driver_min: '450.00', cuda: '11.7' },
];

// ======================================================================
// 5. 硬件规格（显存估算用）
// ======================================================================
/** 单卡显存容量（GB）。取该型号的常见配置。 */
export const GPU_MEMORY_GB = {
  H200: 141,
  B200: 192,
  H100: 80,
  H800: 80,
  A800: 80,
  A100_80: 80,
  A100_40: 40,
  H20: 96,
  L40S: 48,
  L20: 48,
  V100_32: 32,
  V100_16: 16,
  RTX4090: 24,
  RTX3090: 24,
  HYGON_DCU: 64,
};

/** 型号别名，方便模型用常见写法调用。 */
export const GPU_ALIASES = {
  h100: 'H100',
  h800: 'H800',
  h20: 'H20',
  a100: 'A100_80',
  a800: 'A800',
  a100_80: 'A100_80',
  a100_40: 'A100_40',
  h200: 'H200',
  b200: 'B200',
  l40s: 'L40S',
  v100: 'V100_32',
  '4090': 'RTX4090',
  '3090': 'RTX3090',
  dcu: 'HYGON_DCU',
  hygon: 'HYGON_DCU',
};
