/** Source-backed knowledge for evidence-only tools. The compatibility matrix is a 2026-10 snapshot, not live telemetry. */
/** Compatibility-matrix snapshot date displayed in the UI. */
export const VERSION_MATRIX_UPDATED = '2026-10';

/** Keep application defects separate from hardware faults; isolated and rising ECC events require different responses. */
export const CLASSES = {
  application: {
    label: 'Application / code defect',
    short: 'Application',
    hint: 'Fix the code',
    action: 'Locate the failing CUDA code; moving the job to another node will not resolve it.',
    color: 'blue',
  },
  hardware: {
    label: 'Hardware fault',
    short: 'Hardware',
    hint: 'Isolate and request repair',
    action: 'Isolate the GPU or node, collect evidence, and follow the RMA or repair process.',
    color: 'red',
  },
  hardware_watch: {
    label: 'Hardware watch',
    short: 'Watch',
    hint: 'Track trends and act at the threshold',
    action: 'Record frequency and correlated events; immediate repair is not required.',
    color: 'amber',
  },
  environment: {
    label: 'Environment / version mismatch',
    short: 'Environment',
    hint: 'Align the software environment',
    action: 'Align the driver, CUDA runtime, and framework versions.',
    color: 'purple',
  },
  config: {
    label: 'Configuration / resource sizing',
    short: 'Configuration',
    hint: 'Adjust the job configuration',
    action: 'Adjust batch size, sequence length, parallelism, or memory strategy.',
    color: 'teal',
  },
  network: {
    label: 'Network / communication',
    short: 'Network',
    hint: 'Check links and collectives',
    action: 'Check IB/NVLink links, topology, and Fabric Manager state.',
    color: 'coral',
  },
  undetermined: {
    label: 'Insufficient evidence',
    short: 'Undetermined',
    hint: 'Collect more evidence',
    action: 'Collect logs or telemetry and rerun triage.',
    color: 'gray',
  },
};

export const SEVERITY = {
  blocking: { label: 'Blocking', hint: 'The job has failed and requires action' },
  degrading: { label: 'Degrading', hint: 'The job runs with reduced performance or unreliable results' },
  watch: { label: 'Watch', hint: 'No current impact; track the trend' },
};

/** Xid is the most recent event code, not a cumulative count. Use kernel logs for history; Xid 154 requires preceding events. */
export const XID_TABLE = {
  13: {
    name: 'Graphics / compute engine exception',
    name_en: 'Graphics Engine Exception',
    class: 'application',
    severity: 'degrading',
    meaning:
      'The engine encountered an exception, usually an illegal memory access or instruction in application code. ' +
      'The failure typically follows the job across nodes.',
    action: 'Retain the application stack and run Compute Sanitizer on a minimal reproduction.',
    rma: false,
    source: 'https://ai-infrastructure.net/reliability-ras',
  },
  31: {
    name: 'GPU page fault (MMU fault)',
    name_en: 'GPU memory page fault',
    class: 'application',
    severity: 'degrading',
    meaning:
      'The device accessed an unmapped address, often due to an out-of-bounds kernel access. ' +
      'The failure can follow the job across nodes without a hardware fault.',
    action: 'Inspect the failing address and process; reproduce with Compute Sanitizer memcheck.',
    rma: false,
    source: 'https://ai-infrastructure.net/reliability-ras',
  },
  43: {
    name: 'GPU stopped processing (application triggered)',
    name_en: 'GPU stopped processing',
    class: 'application',
    severity: 'blocking',
    meaning:
      'An application-triggered software fault terminated work and invalidated its CUDA context. Restart the process. ' +
      'Check earlier events before classifying the fault as OOM or hardware.',
    action: 'Review application logs and preceding Xids; restart the process and fix the triggering code.',
    rma: false,
    divergence:
      'Sources differ on Xid 43: NVIDIA operational guidance and Alibaba Cloud ACK documentation ' +
      'classify it as an application error; another open diagnostic table associates it with hardware/driver faults ' +
      'after severe ECC errors. ' +
      'Check for correlated Xid 48, 95, or 79 before deciding between hardware and application causes.',
    source: 'https://ai-infrastructure.net/reliability-ras',
  },
  45: {
    name: 'Preemptive cleanup after an earlier error',
    name_en: 'Preemptive cleanup due to previous error',
    class: 'application',
    severity: 'degrading',
    meaning:
      'After an uncorrectable memory error (DBE), the driver cleans up contexts across CUDA applications. ' +
      'This is a consequence of an earlier failure.',
    action: 'Find the preceding root-cause Xid, often 48 or 94/95.',
    rma: false,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  48: {
    name: 'Double-bit ECC error (DBE)',
    name_en: 'Double Bit ECC Error',
    class: 'hardware',
    severity: 'blocking',
    meaning:
      'Uncorrectable GPU memory error; it can terminate jobs and trigger page retirement or GPU reset.',
    action:
      'Stop affected work and check correlated Xid 63/64/94/95 events. Operational guidance suggests ' +
      'RMA if the error recurs within a week.',
    rma: true,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  62: {
    name: 'Internal microcontroller halt (PMU halt)',
    name_en: 'Internal Micro-controller Halt (PMU_HALT_ERROR)',
    class: 'environment',
    severity: 'degrading',
    meaning:
      'The GPU scheduler halted, often during a severe driver race or overflow. ' +
      'Training may stop making progress ' +
      'while nvidia-smi still reports 100% utilization.',
    action:
      'Collect driver and firmware versions and follow the recovery action. ' +
      'Investigate hardware if Xid 79 is also present or the fault recurs.',
    rma: null,
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-xid-errors',
  },
  63: {
    name: 'ECC page retirement / row remapping event',
    name_en: 'ECC page retirement / row remapping event',
    class: 'hardware_watch',
    severity: 'watch',
    meaning:
      'A bad page was retired on older GPUs or remapped to a spare row on newer GPUs. ' +
      'The event alone does not establish complete recovery.',
    action:
      'Read pending/failure state and ECC context; track cumulative trends.',
    rma: false,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  64: {
    name: 'ECC page retirement / row remapping failed',
    name_en: 'ECC page retirement / row remapping failure',
    class: 'hardware',
    severity: 'blocking',
    meaning:
      'Remapping failed, indicating exhausted spare rows and hardware degradation.',
    action: 'Block new work, escalate, and follow recovery guidance; observation alone is insufficient.',
    rma: true,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  65: {
    name: 'ECC mode change notification',
    name_en: 'ECC mode change notification',
    class: 'hardware_watch',
    severity: 'watch',
    meaning: 'ECC operating mode changed; this event alone does not indicate a fault.',
    action: 'Record the event; immediate action is not required.',
    rma: false,
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-xid-errors',
  },
  69: {
    name: 'Graphics engine class error',
    name_en: 'Graphics engine class error',
    class: 'application',
    severity: 'degrading',
    meaning: 'Application misuse of the engine API.',
    action: 'Check API bounds and invalid arguments.',
    rma: false,
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-xid-errors',
  },
  74: {
    name: 'NVLink error',
    name_en: 'NVLink error',
    class: 'network',
    severity: 'degrading',
    meaning:
      'NVLink faults can slow or interrupt collectives. Check the link evidence before considering node reboots.',
    action:
      'Inspect both link endpoints, topology, NVSwitch, and Fabric Manager logs; reduce link speed if needed.',
    rma: null,
    source: 'https://ai-infrastructure.net/reliability-ras',
  },
  79: {
    name: 'GPU fell off the PCIe bus',
    name_en: 'GPU has fallen off the bus',
    class: 'hardware',
    severity: 'blocking',
    meaning:
      'The driver could no longer reach the GPU over PCI Express. Common causes include PCIe link ' +
      'faults, GPU hardware faults, and driver problems.',
    action:
      'Isolate the resource; collect PCIe AER, power, and BMC evidence. Request repair if reseating or changing slots fails.',
    rma: true,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  92: {
    name: 'Elevated single-bit ECC error rate',
    name_en: 'High single-bit ECC error rate',
    class: 'hardware_watch',
    severity: 'watch',
    meaning:
      'Correctable single-bit ECC errors exceed the normal rate. ' +
      'An accelerating SBE rate can precede uncorrectable DBE errors.',
    action:
      'Track weekly error rates and acceleration rather than relying on a single absolute count.',
    rma: false,
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-xid-errors',
  },
  93: {
    name: 'InfoROM write limit reached (non-fatal)',
    name_en: 'Non-fatal violation of provisioned InfoROM wear limit',
    class: 'config',
    severity: 'watch',
    meaning:
      'The driver refused an InfoROM write because the NVFlash protection limit was reached. ' +
      'This usually indicates the write-protection mechanism is active.',
    action: 'Clear the limit with nvflash --elsessionclear; escalate to NVIDIA if it persists.',
    rma: false,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  94: {
    name: 'Contained memory error',
    name_en: 'Contained ECC error',
    class: 'hardware_watch',
    severity: 'watch',
    meaning:
      'The error is contained to one application on supported GPUs (A100 and later). ' +
      'Restart the affected application; other applications can continue. An isolated Xid 94 can be handled by containment.',
    action:
      'Restart the affected application and reset the GPU during a convenient window. An isolated Xid 94 alone does not warrant RMA.',
    rma: false,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  95: {
    name: 'Uncontained memory error',
    name_en: 'Uncontained ECC error',
    class: 'hardware',
    severity: 'blocking',
    meaning:
      'The error spread across applications; reset the affected GPU before restarting applications. ' +
      'A rising Xid 94 rate alongside Xid 95 indicates degradation beyond containment.',
    action: 'Reset the GPU; request RMA if Xid 94 frequency is also rising.',
    rma: true,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  109: {
    name: 'Context switch timeout',
    name_en: 'Context switch timeout',
    class: 'hardware_watch',
    severity: 'watch',
    meaning:
      'The event is not fatal by itself but can precede a more severe fault ' +
      'by minutes or hours. Correlate it with subsequent events.',
    action: 'Correlate later Xids and check whether the job failed within the following hours.',
    rma: null,
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-xid-errors',
  },
  110: {
    name: 'Security fault',
    name_en: 'Security fault error',
    class: 'hardware',
    severity: 'blocking',
    meaning:
      'NVIDIA guidance states this event should be rare without a hardware fault.',
    action: 'Revert recent hardware changes and cold-reset the system; contact the vendor if it persists.',
    rma: true,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  119: {
    name: 'GSP RPC timeout',
    name_en: 'GSP RPC Timeout',
    class: 'environment',
    severity: 'degrading',
    meaning:
      'An RPC request to the GPU GSP timed out, pointing to the firmware/driver stack. ' +
      'This event alone does not establish an HBM or confidential-computing fault.',
    action: 'Collect driver/GSP versions, follow recovery guidance, and upgrade the driver if reproducible.',
    rma: false,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  120: {
    name: 'GSP core error',
    name_en: 'GSP error',
    class: 'environment',
    severity: 'degrading',
    meaning:
      'Code running on the GSP core failed; investigate the firmware/driver stack as with Xid 119.',
    action: 'Reset the GPU or power-cycle the node; update driver/firmware per NVIDIA guidance if it recurs.',
    rma: false,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  121: {
    name: 'Correctable C2C link error',
    name_en: 'C2C Link corrected error',
    class: 'hardware_watch',
    severity: 'watch',
    meaning:
      'The system corrected an error on the C2C NVLink connection between the GPU and Grace CPU. ' +
      'No runtime impact is expected.',
    action: 'Reset the GPU in a maintenance window to retrain the link.',
    rma: false,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  137: {
    name: 'NVLink FLA permission error',
    name_en: 'NVLink FLA privilege error',
    class: 'application',
    severity: 'degrading',
    meaning:
      'The remote MMU reported a fault, such as an illegal peer access. Application code is a common cause; ' +
      'driver or hardware defects are also possible.',
    action:
      'Reproduce with cuda-gdb or Compute Sanitizer memcheck, or set ' +
      'CUDA_DEVICE_WAITS_ON_EXCEPTION=1 and attach a debugger.',
    rma: null,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  140: {
    name: 'Unrecoverable ECC error',
    name_en: 'ECC unrecovered error',
    class: 'hardware',
    severity: 'blocking',
    meaning:
      'An uncorrectable memory error disrupted dynamic page offlining or row remapping.',
    action: 'Reset the GPU; contact the hardware vendor if the issue persists.',
    rma: true,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  154: {
    name: 'GPU recovery action changed',
    name_en: 'GPU recovery action changed',
    class: 'hardware',
    severity: 'degrading',
    meaning:
      'The driver changed its required recovery action to ' +
      'Reset, Reboot, or Drain. Correlate preceding Xids to find the cause.',
    action: 'Perform the requested recovery action and review the Xid that triggered it.',
    rma: null,
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
};

/** Diagnostic principles guide correlation of tool facts before classification. */
export const DIAGNOSTIC_PRINCIPLES = [
  {
    id: 'first_event',
    title: 'First-event principle (T0)',
    detail:
      'When many Xids appear, identify the earliest event (T0). ' +
      'Later events may be consequences and can mislead root-cause analysis.',
    source:
      'https://github.com/openeuler-mirror/witty-diagnosis-agent/blob/master/skills/offline-GPU-fault-diagnosis/references/XID_error_codes.md',
  },
  {
    id: 'causal_chain',
    title: 'Causal correlation: secondary events are consequences',
    detail:
      'Xid 31 followed by 43 can reflect a memory fault stopping work; 48 followed by 45 indicates DBE cleanup. ' +
      'Xid 45 and 154 describe consequences and require earlier evidence.',
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-xid-errors',
  },
  {
    id: 'symptom_vs_cause',
    title: 'Symptoms require root-cause evidence',
    detail:
      'An nvidia-smi driver communication error has several common causes: ' +
      'a module not rebuilt after a kernel upgrade, Secure Boot blocking an unsigned module, missing DKMS, ' +
      'the wrong module variant, or a GPU that fell off the PCIe bus. ' +
      'Check which cause is supported before choosing a repair.',
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-couldnt-communicate-with-driver',
  },
  {
    id: 'trend_over_snapshot',
    title: 'Trends take precedence over snapshots',
    detail:
      'An isolated event such as Xid 94 can be contained. Changes in rate provide stronger evidence. ' +
      'Use 30-day frequency and correlated correctable ECC trends to distinguish watch status from degradation.',
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-xid-errors',
  },
  {
    id: 'dont_conflate',
    title: 'Distinguish similar driver errors',
    detail:
      'NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver and ' +
      'Failed to initialize NVML: Driver/library version mismatch ' +
      'have different causes and recovery paths.',
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-couldnt-communicate-with-driver',
  },
  {
    id: 'no_rma_for_app_bugs',
    title: 'Application faults do not warrant RMA',
    detail:
      'Xid 13/31/43 can follow a failing job across healthy nodes. ' +
      'Confirm hardware evidence before removing GPU capacity for repair.',
    source: 'https://ai-infrastructure.net/reliability-ras',
  },
];

/** Signature matches are hints; classification also requires node and version evidence. */
export const FAILURE_SIGNATURES = [
  {
    id: 'cuda_oom',
    label: 'CUDA out of memory',
    class_hint: 'config',
    patterns: [/CUDA out of memory/i, /torch\.cuda\.OutOfMemoryError/i],
    root_cause:
      'The allocation exceeds available memory due to batch/sequence size, parallelism configuration, ' +
      'or a memory leak.',
    check: [
      'Use estimate_memory for the model, batch, sequence length, and parallelism.',
      'Compare total capacity with allocated and reserved memory in the error.',
      'Check whether gradient checkpointing is enabled.',
    ],
    typical_fix: [
      'Reduce batch size or sequence length.',
      'Enable gradient checkpointing / activation recomputation.',
      'Adjust tensor parallelism or use a GPU with more memory.',
    ],
    source: 'https://pytorch.org/docs/stable/notes/cuda.html',
  },
  {
    id: 'cuda_oom_fragmentation',
    label: 'Allocation failure from memory fragmentation',
    class_hint: 'config',
    patterns: [
      /reserved (?:but )?unallocated/i,
      /GPU \d+ has a total capacity of .* of which .* is free/i,
    ],
    root_cause:
      'Reserved but unallocated memory is available but cannot satisfy a contiguous allocation. ' +
      'Check fragmentation before treating this as insufficient total capacity.',
    check: [
      'Compare free memory with reserved-but-unallocated memory.',
      'Check for temporary allocations with changing shapes during a long run.',
    ],
    typical_fix: [
      'Set PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True.',
      'Restart the process to release the fragmented pool.',
    ],
    source: 'https://pytorch.org/docs/stable/notes/cuda.html#memory-management',
  },
  {
    id: 'illegal_memory_access',
    label: 'Illegal memory access',
    class_hint: 'application',
    patterns: [
      /an illegal memory access was encountered/i,
      /CUDA error: misaligned address/i,
    ],
    root_cause:
      'A device access was out of bounds or misaligned, indicating an application defect. Moving nodes will not fix it. ' +
      'Xid 13 or 31 may describe the same failure.',
    check: [
      'Inspect input shapes at the last forward/backward call before failure.',
      'Check indexing in custom CUDA kernels and third-party operators.',
    ],
    typical_fix: [
      'Reproduce the fault with Compute Sanitizer memcheck.',
      'Disable fusion for suspect operators and verify in eager mode.',
    ],
    source: 'https://ai-infrastructure.net/reliability-ras',
  },
  {
    id: 'device_side_assert',
    label: 'Device-side assertion',
    class_hint: 'application',
    patterns: [/device-side assert triggered/i, /CUDA error: device-side assert/i],
    root_cause:
      'A device assertion failed, often due to a label index outside the class range ' +
      'or invalid input to the loss function.',
    check: [
      'Rerun with CUDA_LAUNCH_BLOCKING=1 to identify the failing operator.',
      'Compare dataset label ranges with model output dimensions.',
    ],
    typical_fix: ['Fix label mappings and out-of-range indices.', 'Validate inputs before the loss function.'],
    source: 'https://pytorch.org/docs/stable/notes/cuda.html',
  },
  {
    id: 'nccl_timeout',
    label: 'NCCL collective timeout',
    class_hint: 'network',
    patterns: [
      /Watchdog caught collective operation timeout/i,
      /NCCL.*(?:unhandled|timeout|timed out)/i,
      /ProcessGroupNCCL.*timed out/i,
    ],
    root_cause:
      'A rank stopped responding during a collective. Possible causes include network/link faults, ' +
      'a stalled GPU, or prolonged CPU-side ' +
      'synchronization. Correlate node Xids before classifying.',
    check: [
      'Use lookup_xid for events on the same node and time window.',
      'Identify the timed-out rank and hardware events on its node.',
      'Exclude data-loading and CPU-side stalls.',
    ],
    typical_fix: [
      'Investigate hardware events before changing NCCL_TIMEOUT.',
      'Do not mask hardware faults by increasing timeouts.',
    ],
    source: 'https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/troubleshooting.html',
  },
  {
    id: 'driver_too_old',
    label: 'NVIDIA driver too old',
    class_hint: 'environment',
    patterns: [
      /NVIDIA driver on your system is too old/i,
      /found version \d{5}/i,
      /CUDA driver version is insufficient for CUDA runtime version/i,
    ],
    root_cause:
      'The driver is below the CUDA runtime requirement. Error text may encode the version ' +
      'without a decimal point (for example, 11040 represents 11.4).',
    check: [
      'Use check_compat to compare driver, CUDA runtime, and torch.',
      'nvidia-smi reports the driver CUDA ceiling, not the installed Toolkit version.',
    ],
    typical_fix: ['Upgrade the driver to meet the runtime requirement.', 'Or use a framework compatible with the current driver.'],
    source: 'https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html',
  },
  {
    id: 'libcudart_missing',
    label: 'CUDA runtime library missing',
    class_hint: 'environment',
    patterns: [
      /libcudart\.so[\.\d]*: cannot open shared object file/i,
      /libcublas\.so[\.\d]*: cannot open shared object file/i,
      /ImportError: libnvrtc/i,
    ],
    root_cause:
      'The dynamic linker cannot locate a CUDA runtime library, often because the base image lacks it ' +
      'or the installed torch CUDA major version differs from the container.',
    check: ['Check LD_LIBRARY_PATH and installed .so versions.', 'Compare the torch CUDA suffix with the image.'],
    typical_fix: ['Install the matching CUDA runtime or use an NGC base image.', 'Align the torch cu suffix with the image.'],
    source: 'https://docs.nvidia.com/cuda/cuda-installation-guide-linux/',
  },
  {
    id: 'no_kernel_image',
    label: 'No kernel image for the GPU architecture',
    class_hint: 'environment',
    patterns: [
      /no kernel image is available for execution on the device/i,
      /CUDA error: no kernel image/i,
    ],
    root_cause:
      'The CUDA binary lacks the current GPU architecture, such as an sm_80-only operator ' +
      'running on Hopper (sm_90).',
    check: ['Compare TORCH_CUDA_ARCH_LIST with the GPU compute capability.', 'Check the architectures supported by the prebuilt wheel.'],
    typical_fix: ['Rebuild for the target GPU or install a compatible wheel.', 'Set the correct TORCH_CUDA_ARCH_LIST.'],
    source: 'https://docs.nvidia.com/cuda/cuda-compiler-driver-nvcc/',
  },
  {
    id: 'nccl_version_mismatch',
    label: 'NCCL version mismatch',
    class_hint: 'environment',
    patterns: [/NCCL version mismatch/i, /ncclInvalidUsage/i, /NCCL internal error/i],
    root_cause: 'Nodes or processes link different NCCL versions and cannot negotiate collectives.',
    check: ['Compare NCCL versions across nodes with check_compat.', 'Check for mixed images or conda environments.'],
    typical_fix: ['Use the same image and NCCL version across nodes.'],
    source: 'https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/troubleshooting.html',
  },
  {
    id: 'bus_error',
    label: 'Bus error / GPU disconnected',
    class_hint: 'hardware',
    patterns: [/Bus error/i, /fallen off the bus/i],
    root_cause:
      'The process received SIGBUS, often with Xid 79. Investigate the PCIe link, ' +
      'power, and GPU hardware.',
    check: ['Inspect same-node Xid events with inspect_node.', 'Check PCIe AER and BMC power events.'],
    typical_fix: ['Isolate the node; request repair if reseating or changing slots fails.'],
    source: 'https://docs.nvidia.com/deploy/xid-errors/',
  },
  {
    id: 'segfault',
    label: 'Segmentation fault',
    class_hint: 'undetermined',
    patterns: [/Segmentation fault/i, /SIGSEGV/i],
    root_cause:
      'The process accessed an invalid address. This can be an application defect or a consequence of a hardware/communication fault. ' +
      'This line alone is insufficient to classify the fault.',
    check: [
      'Check same-node Xids, especially 79/48/95.',
      'Check reproducibility; consistent failures favor code, while intermittent failures warrant hardware checks.',
    ],
    typical_fix: ['Inspect the core dump and crash stack before selecting a recovery path.'],
    source: 'https://ai-infrastructure.net/reliability-ras',
  },
  {
    id: 'ib_link',
    label: 'InfiniBand link fault',
    class_hint: 'network',
    patterns: [/ibv_|IBV_|failed to open ib device/i, /RoCE|link down.*ib/i],
    root_cause: 'An unavailable or degraded IB/RoCE link can cause collective timeouts.',
    check: ['Check Fabric Manager and fabricmanager.log.', 'Inspect link speed and symbol error counts.'],
    typical_fix: ['Isolate affected ports and inspect cables and switches.'],
    source: 'https://docs.nvidia.com/networking/',
  },
  {
    id: 'device_mismatch',
    label: 'Tensor device mismatch',
    class_hint: 'application',
    patterns: [
      /Expected all tensors to be on the same device/i,
      /Expected object of device type/i,
    ],
    root_cause: 'Tensors in one operation are on different devices, indicating a model-code issue.',
    check: ['Check hard-coded cuda:0 references and multi-GPU support.', 'Confirm loss inputs and labels use the same device.'],
    typical_fix: ['Derive devices from model.device instead of hard-coding indices.'],
    source: 'https://pytorch.org/docs/stable/notes/cuda.html',
  },
  {
    id: 'unhandled_cuda_error',
    label: 'Unhandled CUDA error',
    class_hint: 'undetermined',
    patterns: [/CUDA error: unhandled error/i, /RuntimeError: CUDA error/i],
    root_cause:
      'The runtime returned a generic error. The message alone provides little diagnostic evidence; ' +
      'review kernel logs from the same time window.',
    check: ['Use inspect_node for the same-node Xid sequence.', 'Rerun with CUDA_LAUNCH_BLOCKING=1.'],
    typical_fix: ['Collect evidence before classifying the fault.'],
    source: 'https://ai-infrastructure.net/reliability-ras',
  },
  {
    id: 'oom_host',
    label: 'Host out of memory',
    class_hint: 'config',
    patterns: [
      /Cannot allocate memory/i,
      /Out of memory: Killed process.*python/i,
      /bus error.*host/i,
    ],
    root_cause:
      'The host ran out of memory and the OOM Killer terminated the process. Common causes include too many DataLoader workers ' +
      'or large tensors retained on the CPU.',
    check: ['Check dmesg for OOM Killer records.', 'Review DataLoader num_workers and pin_memory.'],
    typical_fix: ['Reduce DataLoader workers.', 'Release unneeded CPU tensor copies.'],
    source: 'https://pytorch.org/docs/stable/data.html',
  },
  {
    id: 'ckpt_shape_mismatch',
    label: 'Checkpoint shape mismatch',
    class_hint: 'config',
    patterns: [
      /size mismatch for/i,
      /Error\(s\) in loading state_dict/i,
      /Missing key\(s\) in state_dict/i,
    ],
    root_cause: 'The model differs from its checkpoint, often after a parallelism or model-configuration change.',
    check: ['Compare state_dict keys and shapes.', 'Check whether weights were resharded after changing parallelism.'],
    typical_fix: ['Reshard the checkpoint for the new parallelism.', 'Or load compatible weights before fine-tuning.'],
    source: 'https://pytorch.org/docs/stable/generated/torch.load.html',
  },

  {
    id: 'smi_cannot_communicate',
    label: 'nvidia-smi cannot communicate with the driver',
    class_hint: 'environment',
    patterns: [
      /NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver/i,
      /couldn't communicate with the NVIDIA driver/i,
    ],
    root_cause:
      'The NVML-to-kernel connection failed. Common causes include: ' +
      'a module not rebuilt for the current kernel; an unsigned module blocked by Secure Boot; ' +
      'missing DKMS modules; nvidia-open installed on an unsupported older GPU; ' +
      'or a GPU that fell off the PCIe bus (Xid 79). ' +
      'Rebuilding modules can address software causes but cannot restore a disconnected GPU.',
    check: [
      'Use dmesg -T | grep -i nvrm to find module-load failures or Xid 79.',
      'Use lsmod | grep nvidia to check loaded modules.',
      'Compare dkms status with uname -r.',
      'Check Secure Boot with mokutil --sb-state.',
      'Use lspci -d 10de: to check whether the GPU is still on the PCI bus.',
    ],
    typical_fix: [
      'Check Xid 79 first; a disconnected GPU requires hardware investigation.',
      'For module faults, rebuild DKMS or reboot.',
    ],
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-couldnt-communicate-with-driver',
  },
  {
    id: 'nvml_mismatch',
    label: 'NVML driver/library version mismatch',
    class_hint: 'environment',
    patterns: [
      /Failed to initialize NVML:\s*Driver\/library version mismatch/i,
      /NVML library version:/i,
    ],
    root_cause:
      'Userspace driver packages were upgraded while the old kernel module remained loaded, often after ' +
      'a partial unattended package upgrade.',
    check: [
      'Compare client and module versions in the NVRM: API mismatch message.',
      'Check recent kernel or automatic package upgrades.',
      'Check whether the node has rebooted since the upgrade.',
    ],
    typical_fix: [
      'Reboot the node to load the matching kernel module.',
      'Or unload uvm, drm, modeset, nvidia in order, then reinstall DKMS.',
      'Exclude nvidia-* from unattended upgrades to prevent partial updates.',
    ],
    source: 'https://ubuntu.com/desktop/docs/en/latest/how-to/graphics/troubleshoot-nvidia/',
  },
  {
    id: 'nvrm_api_mismatch',
    label: 'Kernel/userspace API mismatch',
    class_hint: 'environment',
    patterns: [
      /NVRM:\s*API mismatch:\s*the client has the version/i,
      /this kernel module has the version/i,
    ],
    root_cause:
      'The log reports both client and kernel-module versions. ' +
      'This is kernel-side evidence for an NVML mismatch.',
    check: ['Compare the two logged version numbers.', 'Check upgrade timing and subsequent reboots.'],
    typical_fix: ['Reboot to align kernel and userspace, then exclude nvidia-* from unattended upgrades.'],
    source: 'https://somaz.blog/category/troubleshooting/nvidia-driver-library-mismatch-resolution/',
  },
  {
    id: 'smi_no_devices',
    label: 'nvidia-smi found no devices',
    class_hint: 'environment',
    patterns: [/No devices were found/i, /no NVIDIA GPU found/i],
    root_cause:
      'A loaded nouveau driver may conflict with the proprietary driver; power or device detection can also be responsible.',
    check: ['Use lsmod | grep nouveau to check for a conflict.', 'Use lspci | grep -i nvidia to check device detection.'],
    typical_fix: ['Blacklist nouveau, rebuild initramfs, and reboot.'],
    source: 'https://ubuntu.com/desktop/docs/en/latest/how-to/graphics/troubleshoot-nvidia/',
  },
  {
    id: 'cuda_devices_busy',
    label: 'All CUDA devices busy or unavailable',
    class_hint: 'undetermined',
    patterns: [
      /all CUDA-capable devices are busy or unavailable/i,
      /cudaErrorDevicesUnavailable/i,
    ],
    root_cause:
      'Devices may be exclusively occupied or the driver may be faulty. ' +
      'Check active processes and configuration before inferring hardware failure.',
    check: [
      'Use inspect_node for correlated Xids.',
      'Use nvidia-smi to inspect other GPU processes.',
      'Check container visible-device configuration.',
    ],
    typical_fix: ['Exclude occupancy and configuration issues before investigating driver or hardware.'],
    source: 'https://docs.nvidia.com/deploy/nvml-api/',
  },
  {
    id: 'rm_init_adapter_failed',
    label: 'Driver adapter initialization failed',
    class_hint: 'undetermined',
    patterns: [/RmInitAdapter failed/i, /rm_init_adapter failed/i, /NVRM:.*RmInitAdapter/i],
    root_cause:
      'The kernel module could not initialize the GPU due to a wrong module variant, firmware fault, ' +
      'or an unreachable device.',
    check: ['Check preceding Xids, especially 79/119/120.', 'Check whether lspci still lists the GPU.'],
    typical_fix: ['Follow preceding Xid evidence; otherwise investigate driver and firmware.'],
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-couldnt-communicate-with-driver',
  },
  {
    id: 'secure_boot_block',
    label: 'Kernel module rejected (signature / lockdown)',
    class_hint: 'environment',
    patterns: [
      /module verification failed/i,
      /Lockdown:\s*.*(?:unsigned|signature)/i,
      /Key was rejected by service/i,
    ],
    root_cause:
      'Secure Boot rejected an unsigned NVIDIA module because the machine owner key (MOK) was not enrolled. ' +
      'This can follow driver installation or a kernel upgrade that invalidated the signature.',
    check: ['Check Secure Boot with mokutil --sb-state.', 'Check dmesg for verification or lockdown messages.'],
    typical_fix: ['Sign the module and enroll its MOK, or disable Secure Boot under cluster policy.'],
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-couldnt-communicate-with-driver',
  },

  {
    id: 'gpu_hang_no_progress',
    label: 'GPU stalled at full utilization',
    class_hint: 'undetermined',
    patterns: [
      /GPU hang/i,
      /GPU stopped processing/i,
      /hang detected/i,
      /kernel.*timeout.*GPU/i,
    ],
    root_cause:
      'GPU work stopped progressing while utilization remained at 100% ' +
      'or nvidia-smi queries slowed. ' +
      'Possible causes include application deadlock, driver/GSP faults, NVLink stalls, or hardware failure. ' +
      'Correlate kernel Xids and process state before classifying.',
    check: [
      'Check same-node Xids, especially 62/43/79/74/119.',
      'Check for processes in D state (uninterruptible sleep).',
      'Determine whether all ranks or only some ranks stalled.',
      'A single stalled rank can point to one GPU; inspect its node evidence.',
    ],
    typical_fix: [
      'With Xid 62/79, investigate the driver or hardware.',
      'With only application/NCCL errors and no Xids, inspect rank synchronization and looping kernels.',
      'Do not hide the stall by increasing timeouts.',
    ],
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-xid-errors',
  },
  {
    id: 'smi_itself_hangs',
    label: 'nvidia-smi itself hangs',
    class_hint: 'hardware',
    patterns: [/nvidia-smi.*(?:hang|freeze|stuck|timed out)/i, /执行\s*nvidia-smi\s*超时/i],
    root_cause:
      'The query cannot complete its IOCTL, indicating that the GPU is not responding normally to the driver. ' +
      'Investigate a device stall using kernel evidence.',
    check: ['Use timeout 5 nvidia-smi to confirm a hang.', 'Check dmesg for Xid 62/79.', 'Check for D-state processes.'],
    typical_fix: [
      'Release GPU processes, then try nvidia-smi --gpu-reset -i N.',
      'If reset fails, isolate the GPU and follow the hardware workflow.',
    ],
    source: 'https://help.aliyun.com/zh/ack/ack-managed-and-ack-dedicated/user-guide/use-node-diagnosis-to-self-troubleshoot-gpu-node-problems',
  },
  {
    id: 'gpu_reset_failed',
    label: 'GPU reset failed',
    class_hint: 'hardware',
    patterns: [
      /Unable to reset the GPU/i,
      /In use by another client/i,
      /GPU reset.*(?:failed|not supported)/i,
    ],
    root_cause:
      'Reset can fail because another process still uses the GPU or because the device cannot recover. ' +
      'Distinguish these cases before escalating.',
    check: ['Check occupancy with nvidia-smi or lsof /dev/nvidia*.', 'Check whether Xids continue after reset.'],
    typical_fix: ['Release processes and retry reset; isolate the node if it still fails.'],
    source: 'https://help.aliyun.com/zh/ack/ack-managed-and-ack-dedicated/user-guide/use-node-diagnosis-to-self-troubleshoot-gpu-node-problems',
  },
  {
    id: 'process_d_state',
    label: 'Process stuck in D state',
    class_hint: 'hardware',
    patterns: [
      /\bD\s+state\b/i,
      /\bD</i,
      /uninterruptible sleep/i,
    ],
    root_cause:
      'The process is blocked in an uninterruptible kernel operation, commonly GPU-driver or storage I/O. ' +
      'Signals, including kill -9, cannot terminate it until the kernel operation returns.',
    check: [
      'Use ps -eo pid,ppid,stat,wchan,etime,args | awk \'$4~/^D/\' to find D-state processes.',
      'Inspect cat /proc/PID/stack to identify the blocked driver.',
      'Check same-node Xid events.',
    ],
    typical_fix: [
      'For an NVIDIA driver wait, follow the GPU-stall workflow and reboot if needed.',
      'For a storage wait, investigate metadata or backend congestion.',
    ],
    source: 'https://www.netdata.cloud/guides/nvidia-gpu/nvidia-gpu-couldnt-communicate-with-driver',
  },
];

/** Official CUDA versions supported by prebuilt PyTorch wheels. */
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

/** Minimum Linux x86_64 driver versions. Apply strict compatibility checks; nvidia-smi reports the driver CUDA ceiling. */
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

/** Driver-series CUDA ceilings for reverse compatibility checks. */
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

/** Common per-GPU memory capacity in GB. */
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

/** Supported aliases for GPU model names. */
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
