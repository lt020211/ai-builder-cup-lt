# 训练故障分诊器（Training Failure Triage）

语言：[English](README.md) | 简体中文

Google Cloud AI Builder Cup 2026（JAPAC），Sustainability & Social Impact 方向。

本项目帮助 GPU 平台运维团队区分应用故障与硬件劣化，在下线显卡或发起 RMA 前核对证据。系统结合故障日志、节点遥测、Xid 资料、版本兼容性和显存估算，输出故障分类、RMA 建议、证据引用及处置计划。

## 演示与团队

[打开线上演示](https://gpu-waste-auditor-2026.web.app) | [备用域名](https://gpu-waste-auditor-2026.firebaseapp.com)

演示使用构造案例和 Cloud Firestore 中的 6 个模拟节点，不连接生产集群。

团队：lt020211 - Team Lead and Engineer

仓库中的团队署名不能证明参赛资格；参赛资格以报名后台记录为准。

| 提交物 | 可用文件 |
|---|---|
| 演示视频 | [仓库 MP4](docs/Training-Failure-Triage-demo.mp4)：3:24，1600×900，15 fps，英语旁白、中英双语字幕，正片 21 拍 + 收尾 3 拍 |
| 方案说明 | [PDF deck](docs/Training-Failure-Triage-deck.pdf)：15 页 |

公开视频：[Google Drive 查看链接](https://drive.google.com/file/d/1TLBOoTTjiNSLVGMKatz1rtORza3oBzMU/view)。权限为“知道链接的任何人可查看”。

## 使用流程

| 页面 | 操作与输出 |
|---|---|
| Case triage（案例分诊） | 选择案例，运行分诊，查看六类故障分类、RMA 建议、证据和候选动作。 |
| On-call patrol（值班巡检） | 点击 Run patrol，扫描模拟节点、收集证据、执行允许的低风险动作，再查看操作日志、工单草稿和通知队列。 |
| Benchmark（基准对照） | 本地运行规则基线，或对案例库运行 AI 分诊；AI 结果随案例完成逐项累计。 |
| Action library and approvals（动作库与审批） | 查看风险、命令、预期输出、回滚和审批要求，审核后导出处置执行包。 |

示例中，`lyg2103` 在 30 天内只有 1 次 Xid 94，且可纠正 ECC 持平，预期建议是观察、不发起 RMA；`lyg2112` 有 53 次 Xid 94，可纠正 ECC 为 118 且持续上升，预期建议是硬件升级排查并发起 RMA。判断依据包含事件趋势和相关遥测。

## 架构与证据

浏览器从 Firebase Hosting 加载静态 JavaScript，通过 Firebase AI Logic 调用 Gemini。Firestore 保存模拟集群状态、操作记录、工单草稿和通知队列。

| 模块 | 职责 |
|---|---|
| `kb.js`、`triage.js` | 知识资料、确定性预分析、版本检查、显存估算和离线规则基线 |
| `tools.js` | 10 个工具、参数白名单和证据引用；案例分诊开放 6 个，巡检开放 10 个 |
| `prompt.js`、`ai.js` | 英文提示词、工具调用、模型回退、进度续跑和标注清楚的离线输出 |
| `actions.js`、`cluster.js` | 动作风险、人工审批、模拟状态更新及回验记录 |
| `app.js` | 页面交互、报告、调用轨迹、基准和下载 |

`snapshot` 证据来自案例内冻结的遥测，`live` 证据来自当前模拟集群状态。`artifact` 层尚未实现，请求该层会抛错。

REA is not included in this build. The browser application produces snapshot and live evidence only. A future CLI or server deployment could evaluate rea-agents for local artifact inspection.

技术细节见[中文架构说明](docs/architecture.md)或[当前英文架构说明](docs/architecture.en.md)。演示流程见[中文分镜](docs/demo-script.md)和[当前英文演示脚本](docs/demo-script.en.md)。

## F8 基准

F8 对 14 个构造案例同时核对分类和 `should_rma`。规则基线两项均正确的结果为 **11/14（78.6%）**；单独分类为 11/14，单独 RMA 决策为 12/14。

| 规则基线未通过的案例 | 需要核对的证据 |
|---|---|
| `case-xid48-dbe` | 区分先发生的双位错误与次生 Xid 45。 |
| `case-xid94-rising` | 结合 30 天频次和 ECC 趋势识别劣化。 |
| `case-gpu-hang-deadlock` | 通过内核日志和进程状态识别代码死锁。 |

运行 `node scripts/verify_triage.mjs`，或在浏览器点击 Run rule baseline (local)，可复现该结果。案例库规模较小且为构造数据，不能据此估计生产准确率。AI 汇总结果在全部 14 个案例完成后显示；本文不声明 AI 总体准确率。

## 已记录的巡检结果

| 记录 | 工具调用 | 操作与输出 | 用时 |
|---|---|---|---|
| 一次历史线上运行 | 16 次 | 2 次已回验的 cordon，1 份工单草稿，1 条排队通知 | 41.2 秒 |
| 仓库现有演示视频 | 17 次 | 2 条操作记录，3 条排队通知 | 正片总长 2:44（全片 3:24） |

这些数值对应各自的运行记录。工具路径、动作和通知数量可能随模型输出及初始状态变化，视频时长也不等于巡检执行时长。

2026-10-14 的演示记录中，一轮巡检按工具轮次折算约需 12–16 次模型请求；单模型免费日配额实测约 20 次，当时的多模型回退配置约支持每天 5–6 轮巡检。上述请求量包含折算和估算，不能作为当前配额或运行成本的保证。

## 安全边界

- 动作库共 **14 个动作：6 个低风险、5 个中风险、3 个高风险**。风险由动作库代码指定，模型只选择动作 ID。
- 自动 `execute_action` 仅接受低风险动作，并且只修改模拟集群。中高风险动作进入人工审批；RMA 保持为工单草稿。
- Cordon 阻止新任务进入，保留正在运行的任务。状态更新后会检查结果，操作日志记录回验状态。
- 通知以 `queued` 状态保留在 Firestore；本构建未接入 IM 或邮件投递。
- 导出的执行包供人工审核和手动使用，不会在目标节点上自动执行命令。
- 演示允许匿名读写 `cluster`、`events`、`tickets`、`notifications` 四个集合。生产部署需要认证、访问控制和 App Check。

## 本地运行与验证

启动静态服务，然后打开[本地页面](http://127.0.0.1:8899/)：

```bash
python3 -m http.server 8899 --directory firebase/public
```

使用 Node.js 18 或更高版本运行：

```bash
node scripts/verify_triage.mjs
node scripts/verify_pipeline.mjs
node scripts/verify_submission.mjs --prepublish
node scripts/verify_submission.mjs
```

前两项为离线检查。提交验证器的 prepublish 模式允许公开视频待上传；严格模式要求具体的 Google Drive viewer/share URL，并检查上方已发布的链接。

`node scripts/browser_check.mjs http://127.0.0.1:8899/` 使用 Chrome 进行验收，会消耗模型配额并读写共享模拟 Firestore 状态。

## 部署

在已认证且具备所需 Google Cloud 权限的环境中发布静态目录：

```bash
python3 scripts/fb_deploy.py firebase/public
```

`python3 scripts/fb_firestore_setup.py check` 只读检查数据库与规则。该脚本的 `rules`、`seed` 和 `verify` 分别写入规则、重置模拟数据或执行读写探针，运行前应明确所需变更。

## 限制

知识库覆盖 24 条 Xid、27 条故障特征和 6 条诊断原则。案例和遥测均为构造数据，诊断结论需要人工复核；涉及调度平台的通用处置命令需要适配。

界面和提示词默认为英文。巡检由人工点击启动，没有常驻监控进程或结果缓存。连续监控需要服务端与调度器，生产使用还需要遥测采集、调度平台对接和通知投递。模型延迟及可用性受配额和上游服务影响，在线重试耗尽后会返回标注为离线规则的结果。

[MIT 许可](LICENSE)
