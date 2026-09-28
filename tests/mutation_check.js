#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 * 变异验证（Mutation Check）—— 证明"回归测试网真的能抓到回归"
 * ============================================================================
 * 一个永远不会变红的测试网等于没有测试网。
 *
 * 本脚本把历史上真实发生过的结构性缺陷逐条"重新种回去"（变异），
 * 然后在隔离的临时副本上运行 tests/regression.test.js：
 *   - 若测试网变红（退出码非 0）→ 说明该缺陷确实被守住了，判为 PASS；
 *   - 若测试网仍然全绿 → 说明测试网对该缺陷是瞎的，判为 FAIL（必须补断言）。
 *
 * 原仓库文件全程只读，所有变异只发生在临时副本目录内，结束后删除。
 * 用法：node tests/mutation_check.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;


/**
 * 每个变异：把 file 中的 from 替换为 to（replaceAll 可选），
 * 期望 regression.test.js 因此变红。
 */
const MUTATIONS = [
  {
    id: 'M1',
    name: '暗线A/字段漂移：把 sign 的映射改回错误的 features.sign',
    file: 'server.js',
    from: "sign: 'autoSign'",
    to: "sign: 'sign'",
    replaceAll: false,
  },
  {
    id: 'M2',
    name: '暗线A/原始直读：保活闸门退回 d.keepaliveEnabled === false',
    file: 'server.js',
    from: "if (!this.resolveTask('keepAlive', d).enabled) continue; // 统一入口：账号级/(该机)独立保活开关",
    to: "if (d.keepaliveEnabled === false) continue;",
    replaceAll: false,
  },
  {
    id: 'M3',
    name: '暗线A/调度器直读：打卡闸门退回 acc.features?.autoSign !== false',
    file: 'app/tasks/scheduler.js',
    from: "this.taskGate(acc, 'sign')",
    to: 'acc.features?.autoSign !== false',
    replaceAll: true,
  },
  {
    id: 'M4',
    name: '调度器死锁(#32)：把 isRunning 复位改名，脱离 finally 约束',
    file: 'app/tasks/scheduler.js',
    from: 'this.isRunning = false;',
    to: 'this.isRunningResetByMutation = false;',
    replaceAll: true,
  },
  {
    id: 'M5',
    name: 'AI对话卡死(#35)：移除主动超时 AbortSignal.timeout',
    file: 'app/tasks/native_tasks.js',
    from: 'AbortSignal.timeout(',
    to: 'noActiveTimeoutSignal(',
    replaceAll: true,
  },
  {
    id: 'M6',
    name: '暗线C/虚报成功：把打卡待确认态 pendingVerify 改名（模拟未确认即报完成）',
    file: 'app/tasks/native_tasks.js',
    from: 'pendingVerify',
    to: 'pendConfirmState',
    replaceAll: true,
  },
  {
    id: 'M7',
    name: '脏手段复活：在 app/ydpc/ 下新建未纳入红线扫描的文件（伪造直连开机指纹）',
    createFiles: [
      {
        path: 'app/ydpc/sc_direct_boot.js',
        content:
          "// mutation: 新建带 scBootVm 指纹的直连开机文件\n" +
          "function scBootVm() { return 'sc-boot'; }\n" +
          'module.exports = { scBootVm };\n',
      },
    ],
  },
  {
    id: 'M8',
    name: '脏手段复活：把硬编码第三方 SC 客户端 ID 注入 cag_boot.js（伪造官方身份）',
    file: 'app/ydpc/cag_boot.js',
    from: "'use strict';",
    to: "'use strict';\nconst FORGED_SC_CLIENT_ID = 'sc-user-5e38ece5';",
    replaceAll: false,
    optional: true,
  },
  {
    id: 'M9',
    name: '脏手段复活：在 cag_boot.js 关闭 TLS 证书校验（rejectUnauthorized:false）',
    file: 'app/ydpc/cag_boot.js',
    from: "'use strict';",
    to: "'use strict';\n// mutation\nconst BAD = { rejectUnauthorized: false };",
    replaceAll: false,
    optional: true,
  },
  {
    id: 'M10',
    name: '多机回退：移动云「当前动作」退回账号级单行（acc-vm-actions → acc-hb-text）',
    file: 'app/static/app.js',
    from: 'id="acc-vm-actions-${acc.id}"',
    to: 'id="acc-hb-text-${acc.id}"',
    replaceAll: false,
  },
  {
    id: 'M11',
    name: '根因复发：账号级摘要退回固定文案「保活巡检待命中」（运行时不刷新）',
    file: 'app/ydpc/ydpc_client.js',
    from: "    if (vms.length === 0) return '名下暂未发现云电脑';",
    to: "    if (vms.length >= 0) return '保活巡检待命中';",
    replaceAll: false,
  },
  {
    id: 'M12',
    name: '多机失明：describeVmKeepAlive 不再区分单机保活开关（全部按"已开启"渲染）',
    file: 'app/ydpc/ydpc_client.js',
    from: "    const keepaliveOn = !vm || vm.keepaliveEnabled !== false;",
    to: '    const keepaliveOn = true;',
    replaceAll: false,
  },
  {
    // 2026-09-24 新增：这不是假想缺陷，是**刚刚造成真实事故**的那一个——
    // 常量被引用却从未定义 → 默认参数求值即 ReferenceError → 保活循环从未排程，
    // 该账号下所有主机静默 >12 小时，云电脑被平台自动关机。
    id: 'M13',
    name: '【真实事故】核验看门狗常量被改名 → 启动期 ReferenceError（保活静默停摆）',
    file: 'app/ydpc/ydpc_client.js',
    from: 'const EFFECT_VERIFY_INTERVAL_MS = Math.max(',
    to: 'const EFFECT_VERIFY_INTERVAL_MS_RENAMED = Math.max(',
    replaceAll: false,
  },
  {
    // 2026-09-24 新增：同一次事故的第二条同源缺陷——SOHO 出网请求丢掉主动超时，
    // 回到 undici 默认 300s：一次"连上但不回包"就让整账号保活静默停摆 20~30 分钟。
    id: 'M14',
    name: '【真实事故】soho_client 丢掉主动超时（回到 undici 默认 300s）',
    file: 'app/ydpc/soho_client.js',
    from: 'signal: AbortSignal.timeout(timeoutMs)',
    to: 'signal: undefined',
    replaceAll: false,
  },
  {
    // 2026-09-24 新增：这是**用户当天就看见的故障**——「已关机（未开启自动开机守护），
    // 本次不自动拉起」每分钟刷一条（实测单日 8 次/台）。
    // 根因是 refreshVms 差量合并的"本机状态白名单"漏列了 _hasNotifiedOff 等去重标记，
    // 每次刷新重建 vm 对象后标记被清空，闸门又放行 → 重复打印。
    // 本变异把"按 `_` 前缀泛化保留"整段删掉，模拟这次漏列的原始形态。
    // 组 12/10 的「差异合并必须泛化保留 `_` 前缀本机状态」断言必须因此变红。
    id: 'M15',
    name: '【真实故障】refreshVms 合并丢掉 `_` 前缀泛化保留（去重标记每轮被清空 → 关机提示刷屏）',
    file: 'app/ydpc/ydpc_client.js',
    from: '          for (const k of Object.keys(old)) {\n' +
          "            if (k.startsWith('_') && old[k] !== undefined) vm[k] = old[k];\n" +
          '          }\n',
    to: '',
    replaceAll: false,
  },
  {
    // 2026-09-24 新增（随"移动公众融合"P1 一起加入）：用户拍板协议常量走方案 B（外置），
    // 本变异把凭据硬编码回 config.py，模拟"图省事把字面值塞回源码"的倒退。
    // 注：此处刻意用**假值**，真实凭据绝不写进测试文件（本仓库为 Public）。
    // 组 14 的「方案 B：协议凭据不得出现在源码里」断言必须因此变红。
    id: 'M16',
    name: '方案B倒退：把 AccessKey 硬编码回 ecloud config.py（凭据入库 → Public 泄露）',
    file: 'app/ecloud_engine/config.py',
    from: 'ACCESS_KEY = _ACCESS_KEY',
    to: 'ACCESS_KEY = "0123456789abcdef0123456789abcdef"',
    replaceAll: false,
  },
  {
    // 2026-09-24 新增：用户明令「三个平台的保活机制不要重叠，各自独立」。
    // 本变异让 ecloud 桥接层反过来 require 移动爱家的 ydpc 实现 —— 正是"机制重叠"的开端。
    // 组 14 的「三平台保活不重叠」断言必须因此变红。
    id: 'M17',
    name: '三平台重叠：ecloud 桥接层改为复用移动爱家 ydpc 保活实现',
    file: 'app/ecloud/ecloud_engine.js',
    from: "'use strict';",
    to: "'use strict';\nconst { YdpcClient } = require('../ydpc/ydpc_client.js'); // mutation",
    replaceAll: false,
  },
  {
    // 2026-09-24 新增：对应方案书风险 R6（侧车崩溃被静默）。
    // 把 _failAllPending 整体改名 → 退出时在途请求不再失败、界面照旧显示"保活中" = 假成功。
    // 组 14 的「侧车退出绝不静默」断言必须因此变红。
    id: 'M18',
    name: '静默退出：侧车退出不再让在途请求失败（重演"假成功"）',
    file: 'app/ecloud/ecloud_engine.js',
    from: '_failAllPending',
    to: '_silentlyIgnorePending',
    replaceAll: true,
  },
  {
    // 2026-09-24 新增（随"接入主程序"一起加入）：调度器若不再把 ecloud 排除出
    // "天翼云任务链"，移动公众账号会被当成天翼云账号去跑打卡/挂机/兑换 —— 正是
    // 用户明令禁止的"三平台机制重叠"。
    // 组 15 的「scheduler 必须把 ecloud 与天翼云任务链隔离」断言必须因此变红。
    // 注意：from 必须**单行**（不含换行）。本项目源码在 Windows 下是 CRLF，
    // 跨行 from 若用 "\n" 拼接会因 \r 静默失配 → 变异根本没生效（BROKEN）。
    id: 'M19',
    name: '三平台重叠：调度器不再把 ecloud 排除出天翼云任务链',
    file: 'app/tasks/scheduler.js',
    from: "      if (acc.platform === 'ecloud') continue; // 移动公众保活为常态巡检，无官方任务达成度可言",
    to: '      // mutation：ecloud 不再从达成度巡检中排除',
    replaceAll: false,
  },
  {
    // 【2026-09-26 修订】用户拍板：L3（SPICE 心跳）从未实现，整层删除 —— 原"默认值翻 true"
    // 的变异随之作废，改指新的红线：**L3 字段不得从默认值里复活**。
    // 组 15 的「L3 字段必须从默认值里消失」断言必须因此变红。
    id: 'M20',
    name: 'L3 复活：把已删除的 SPICE 心跳层塞回账号默认开关（与用户拍板相反）',
    file: 'server.js',
    from: '    ecloudL2DesktopReg: true,     // L2 桌面登记保活',
    to: '    ecloudL2DesktopReg: true,     // L2 桌面登记保活\n    ecloudL3SpiceHeart: false,    // mutation：已删除的 L3 复活',
    replaceAll: false,
  },
  {
    // 2026-09-24 新增：重演代价最大的一次事故 —— 把"全端点失败但非 token 错误"
    // 也当成 token 失效去重登，导致高频密码登录 → 短信轰炸。
    // 组 15 的「ok=null 分支内绝不请求重登」断言必须因此变红。
    id: 'M21',
    name: '【真实事故】ok=null 分支误加重登 → 高频密码登录（短信轰炸成因）',
    file: 'app/ecloud/ecloud_client.js',
    from: '    this.metrics.l1.unknownCount += 1;',
    to: "    this.metrics.l1.unknownCount += 1;\n    await this.engine.request('session.relogin', this._loginParams(), this.sessionId);",
    replaceAll: false,
  },
  {
    // 2026-09-24 新增：会话契约缺陷回归（桥接层把 sessionId 放在报文顶层，而 op 从
    // params 读取 → 所有会话内操作都报"会话不存在"）。本变异删除 main() 里的回填。
    // 组 15 的「顶层 sessionId 必须被回填进 params」与 IPC 契约行为断言必须因此变红。
    id: 'M22',
    name: '会话契约退化：不再把顶层 sessionId 回填进 params（所有会话内 op 都会找不到会话）',
    file: 'app/ecloud_engine/sidecar.py',
    from: '                params["sessionId"] = req.get("sessionId")',
    to: '                pass  # mutation: 不再回填 sessionId',
    replaceAll: false,
  },
  {
    id: 'M23',
    name: '三平台前端重叠：移动公众卡片改为调用移动爱家的逐台渲染器',
    file: 'app/static/app.js',
    from: '${buildEcloudDesktopMonitorHtml(acc)}',
    to: '${buildYdpcVmMonitorHtml(acc)}',
    replaceAll: false,
  },
  {
    // 【2026-09-26 修订】L3 UI 开关已整层删除 —— 原"复选框默认勾选"变异随之作废，
    // 改指新的红线：前端不得出现任何 ecloudL3SpiceHeart 痕迹。
    // 组 16 的「L3 开关不得复活」断言必须因此变红。
    id: 'M24',
    name: 'L3 UI 复活：移动公众卡片重新长出已删除的 L3 开关痕迹',
    file: 'app/static/app.js',
    from: "onchange=\"toggleFeature('${acc.id}', 'ecloudL2DesktopReg', this.checked)\"",
    to: "onchange=\"toggleFeature('${acc.id}', 'ecloudL2DesktopReg', this.checked)\" data-mutation=\"ecloudL3SpiceHeart\"",
    replaceAll: false,
  },
  {
    id: 'M25',
    name: '日志平台隔离被放宽：移动公众筛选不再是"绝对隔离"',
    file: 'app/static/app.js',
    from: "activePlatformFilter === 'ecloud' && item.platform !== 'ecloud'",
    to: "activePlatformFilter === 'ecloud' && item.platform === 'ydpc'",
    replaceAll: false,
  },
  {
    id: 'M26',
    name: '短信登录只提示不发码：need_* 分支移除 loginSendSms 调用（复现用户报障的"收不到验证码"）',
    file: 'server.js',
    from: 'await draftClient.loginSendSms(status, mobile);',
    to: '/* M26: 发码被移除 */',
    replaceAll: false,
  },
  {
    id: 'M27',
    name: '短信 codeType 走错分支：trust 分支改用 codeType="login"（真网 30002004 验证码失败）',
    file: 'app/ecloud_engine/sidecar.py',
    from: 'login_mod.send_sms(http, mobile, code_type="trust")',
    to: 'login_mod.send_sms(http, mobile, code_type="login")',
    replaceAll: false,
  },
  {
    id: 'M28',
    name: '前端假成功：短信提示不再区分 smsSent === false（发码失败也宣称"已下发"）',
    file: 'app/static/app.js',
    from: 'if (info && info.smsSent === false) {',
    to: 'if (false) {',
    replaceAll: false,
  },
  {
    id: 'M29',
    name: '短信分支名自造：need_device_trust 退回自造短名 "trust"（复现用户报障"未知的短信分支"）',
    file: 'app/ecloud_engine/sidecar.py',
    from: 'branch == login_mod.LoginResult.NEED_DEVICE_TRUST',
    to: 'branch == "trust"',
    replaceAll: true,
  },
  {
    id: 'M30',
    name: '短信分支名自造：need_enhanced_sms 退回自造短名 "enhanced"（同上，覆盖另一分支）',
    file: 'app/ecloud_engine/sidecar.py',
    from: 'branch == login_mod.LoginResult.NEED_ENHANCED_SMS',
    to: 'branch == "enhanced"',
    replaceAll: true,
  },
  {
    // 2026-09-24 新增（随"分层明细进日志"一起加入）：复现用户报障 ——
    // 保活成功路径不落日志，于是实时控制台里"移动公众"只剩登录记录，
    // 用户据此误判"保活根本没在跑"。组 16 的「L1 成功路径必须写日志」断言必须因此变红。
    id: 'M31',
    name: '【真实报障】保活成功不落日志：移除 L1 成功日志（日志流只剩登录记录）',
    file: 'app/ecloud/ecloud_client.js',
    from: "      this._log('L1 账号态探针通过（HTTP 层探针 ≠ 云电脑不会被关机）', 'success');",
    to: '      /* M31: L1 成功日志被移除 */',
    replaceAll: false,
  },
  {
    // 卡片上的分层总览条已按用户要求删除 ⇒ 日志流是 L1/L2 明细的**唯一出口**。
    // 本变异把这唯一的出口也掐掉（信息黑洞）。组 16 的分层日志断言必须因此变红。
    id: 'M32',
    name: '分层明细不进日志：自动巡检不再调用 _logLayerSummary（卡片已删 ⇒ 三层状态彻底不可见）',
    file: 'app/ecloud/ecloud_client.js',
    from: '        if (acted) this._logLayerSummary();',
    to: '        /* M32: 分层日志被移除 */',
    replaceAll: false,
  },
  {
    // 卡片上的免责说明框已按用户要求删除 ⇒ 诚实性口径**只剩日志流这一个出口**。
    // 本变异把这最后一句口径也抹掉（"探针成功"于是又变成一句没有边界的话）。
    // 组 16 的「诚实性口径必须仍存在于日志流」断言必须因此变红。
    id: 'M33',
    name: '诚实性口径整体消失：日志里的「探针成功不代表不会被关机」被抹掉（卡片已无说明 ⇒ 无人再设边界）',
    file: 'app/ecloud/ecloud_client.js',
    from: '说明: L1/L2 是 HTTP 层探针，成功不代表云电脑不会被关机',
    to: '说明: L1/L2 是 HTTP 层探针',
    replaceAll: false,
  },
  {
    // 2026-09-24 第二轮（UI 一致性）：用户判「移动公众不要搞特殊」。
    // 本变异把 CMSSZTE 厂商徽章的色板改回移动公众自己的蓝 —— 与移动爱家的中兴 ZTE 不一致。
    // 组 16 的「厂商徽章色板必须与移动爱家一致」断言必须因此变红。
    id: 'M34',
    name: 'UI 搞特殊：把移动公众厂商徽章 CMSSZTE 改回蓝色（与移动爱家的中兴 ZTE 颜色不一致）',
    file: 'app/static/app.js',
    from: 'background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;font-size:9.5px;padding:0 5px;line-height:1.3;">${escapeHtml(d.originCompanyCode)}',
    to: 'background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd;font-size:9.5px;padding:0 5px;line-height:1.3;">${escapeHtml(d.originCompanyCode)}',
    replaceAll: false,
  },
  {
    // 2026-09-24 第二轮：用户要求三平台「当前动作」文字颜色一致。
    // 本变异把移动公众的 ok 色改回原先的 teal —— 两平台颜色又分家了。
    // 组 16 的「ok 色必须与移动爱家一致」断言必须因此变红。
    id: 'M35',
    name: '「当前动作」配色分家：把移动公众 ok 色调回 teal（与移动爱家的绿不一致）',
    file: 'app/static/app.js',
    from: "  ok: '#16a34a',     // 探针通过",
    to: "  ok: '#0d9488',     // 探针通过",
    replaceAll: false,
  },
  {
    // 2026-09-24 第二轮：用户要求删掉逐台监视行里的「参与保活」徽章（与列表重复）。
    // 本变异把它塞回去 —— 模拟"减法被后人顺手加回来"。
    // 组 16 的「监视行不得再渲染启用徽章」断言必须因此变红。
    // 注意：from 必须**单行**（本项目源码在 Windows 下是 CRLF，跨行 from 会因 \r 静默失配）。
    id: 'M36',
    name: '减法回退：把「参与保活」徽章重新塞回移动公众逐台监视行',
    file: 'app/static/app.js',
    from: '>${escapeHtml(name)}</span>',
    to: '>${escapeHtml(name)}</span><span class="badge">参与保活</span>',
    replaceAll: false,
  },
  {
    // 2026-09-24 第三轮：用户要求删掉两个监视板块的账号级「保活在线」logo，改为可折叠标题。
    // 本变异把徽章元素塞回移动公众监视板块的折叠标题里 —— 模拟"减法被后人顺手加回来"。
    // 组 18 的「账号级徽章不得复活」断言必须因此变红。
    // 注：2026-09-25 第七轮标题已精简为「移动公众 保活监视」，from/to 随之同步 ——
    //     字面量不同步会导致"变异施加不上"，从而被误判为"原代码已修复"（假绿）。
    id: 'M37',
    name: '减法回退：把账号级「保活在线」徽章塞回移动公众监视板块',
    file: 'app/static/app.js',
    from: '>📡 移动公众 保活监视</span>',
    to: '>📡 移动公众 保活监视</span><span id="acc-status-badge-${acc.id}"></span>',
    replaceAll: false,
  },
  {
    // 2026-09-24 第三轮：用户报「自动滚到底部却看不到那条被更新的记录」。
    // 本变异撤销"折叠后把 DOM 行移到底部"这一步 —— 复现原缺陷。
    // 组 18 的「折叠后必须把 DOM 行移动到列表末尾」断言必须因此变红。
    id: 'M38',
    name: '日志错位：折叠更新后不再把该行移到底部（复现"滚到底部看不到更新"）',
    file: 'app/static/app.js',
    from: 'logBox.appendChild(existing);',
    to: 'void existing;',
    replaceAll: false,
  },
  {
    // 2026-09-24 第三轮：用户要求日志默认显示「全部」而不是「任务」分栏。
    // 本变异把默认值改回 tasks —— 复现"默认显示的是分栏目"。
    // 组 18 的「activeLogFilter 默认必须为 all」断言必须因此变红。
    id: 'M39',
    name: '默认分栏回退：日志默认筛选改回「任务」分栏',
    file: 'app/static/app.js',
    from: "let activeLogFilter = 'all';",
    to: "let activeLogFilter = 'tasks';",
    replaceAll: false,
  },
  {
    // 2026-09-24 第三轮：后端折叠时不再把条目移到 logs 末尾。
    // 组 18 的「后端折叠后必须移到末尾（时间顺序）」断言必须因此变红。
    id: 'M40',
    name: '时间倒挂：后端折叠后不再把日志条目移到 logs 末尾',
    file: 'server.js',
    from: 'if (at !== logs.length - 1) {',
    to: 'if (false) {',
    replaceAll: false,
  },
  {
    // 2026-09-24 第四轮：模拟"移动爱家卡片的动作文字又不写 font-size"（回退为继承 14px）。
    // 组 19 的「三平台动作文字必须显式 11.5px」断言必须因此变红。
    id: 'M41',
    name: '字号回退：移动爱家「当前动作」动作文字不再声明 font-size',
    file: 'app/static/app.js',
    from: '<span title="${escapeHtml(view.actionText || \'\')}" style="font-size: 11.5px; color: ${toneColor};',
    to: '<span title="${escapeHtml(view.actionText || \'\')}" style="color: ${toneColor};',
    replaceAll: false,
  },
  {
    // 2026-09-24 第四轮：同上，改由移动公众（ecloud）侧漏声明，验证断言的另一条腿也会变红。
    id: 'M42',
    name: '字号回退：移动公众「当前动作」动作文字不再声明 font-size',
    file: 'app/static/app.js',
    from: '<span title="${escapeHtml(actionText)}" style="font-size: 11.5px; color: ${toneColor};',
    to: '<span title="${escapeHtml(actionText)}" style="color: ${toneColor};',
    replaceAll: false,
  },
  {
    // 2026-09-25 第五轮 / 第六轮：复原"数字不归一化" ⇒ 每轮心跳的文本都不同 ⇒ 折叠键每轮都变
    // ⇒ 同一件事逐条新增。这正是用户看到的「progress hb_sent= 后面有区别就不合并了」。
    // 组 20 的行为断言（progress 夹在同源/他源日志之间仍须收敛为 1 条）必须因此变红。
    id: 'M43',
    name: '折叠失效：例行日志折叠键不再把数字归一化（progress 逐条新增成一长串 xN）',
    file: 'server.js',
    from: "  return String(message).replace(/\\d+/g, 'N');",
    to: '  return String(message);',
    replaceAll: false,
  },
  {
    // 2026-09-25 第五轮：把移动公众「分层巡检结果」从例行模式表里删掉
    // ⇒ 该日志每轮都会新增一行（用户报障"重复太多次了"）。组 20 必须变红。
    id: 'M44',
    name: '例行模式缺失：移动公众「分层巡检结果」不再被识别为可折叠的例行日志',
    file: 'server.js',
    from: "  '分层巡检结果',          // 移动公众 L1/L2 汇总汇报",
    to: '  // 变异：删除「分层巡检结果」模式',
    replaceAll: false,
  },
  {
    // 2026-09-25 第五轮：去掉移动爱家时间行的 title ⇒ 被 ellipsis 截断的内容无处可看。
    id: 'M45',
    name: '悬停失效：移动爱家「上次保活」行不再挂 title',
    file: 'app/static/app.js',
    from: '<div title="${escapeHtml(timeLineFull)}" style="font-size: 11.5px; color: #475569; padding-left: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${timeLine}',
    to: '<div style="font-size: 11.5px; color: #475569; padding-left: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${timeLine}',
    replaceAll: false,
  },
  {
    // 2026-09-25 第六轮：把 SSE 里的幂等落盘改回"无条件 appendChild"。
    // 服务端每次连接都会重发最近 80 条历史 ⇒ 每重连一次整屏日志翻一倍。
    // 组 21 的「新增与更新必须共用同一条幂等路径」断言必须因此变红。
    id: 'M46',
    name: '日志翻倍：SSE 处理重新无条件 appendChild（重连重发历史导致同一件事铺满一屏）',
    file: 'app/static/app.js',
    from: '      upsertLogLine(logBox, item);',
    to: '      if (logBox) logBox.appendChild(createLogLineElement(item));',
    replaceAll: false,
  },
  {
    // 2026-09-25 第六轮：把内存数组的 upsert 退化成"永远追加"。
    // 组 21 的幂等行为断言（同一 id 历史重发 10 次只能剩 1 条）必须因此变红。
    id: 'M47',
    name: '列表重复：内存日志数组不再按身份键去重（同一件事堆成 N 条快照）',
    file: 'app/static/app.js',
    from: '  const idx = list.findIndex(l => logLineKey(l) === key);',
    to: '  const idx = -1;',
    replaceAll: false,
  },
  {
    // 2026-09-25 第七轮（诚实性红线）：让 unknown 落进「已关机」分支。
    // 后果：取不到运行状态时界面宣称"已关机"，用户会以为机器掉了 —— 比不显示更坏。
    // 组 22 的「unknown 必须渲染状态未知」断言必须因此变红。
    id: 'M48',
    name: '诚实性红线：运行状态 unknown 被渲染成「已关机」（把"不知道"说成"已关机"）',
    file: 'app/static/app.js',
    from: ": (powerState === 'off'",
    to: ': (true',
    replaceAll: false,
  },
  {
    // 2026-09-25 第七轮（字号回退）：摘掉移动爱家监视行主机名的 font-size。
    // 该 span 会继承浏览器默认 16px（.features-box / .account-card 均未声明字号），
    // 复现用户报的"云电脑省侧部署包高阶版月报 / 8C16G版云电脑月包 字体偏大"。
    // 组 22 的「主机名必须显式 12px（恰好 2 处）」断言必须因此变红。
    id: 'M49',
    name: '字号回退：移动爱家监视行主机名不再声明 font-size（回到继承 16px 的偏大状态）',
    file: 'app/static/app.js',
    from: '<span style="font-size: 12px; font-weight: 700; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(vmName)}</span>',
    to: '<span style="font-weight: 700; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(vmName)}</span>',
    replaceAll: false,
  },
  {
    // 2026-09-25 第七轮（悬停失效）：instanceId 行不再挂 title。
    // 该行会被 ellipsis 截断（CCA-<32hex> 很长），去掉 title 后用户再也看不到完整 ID。
    // 组 22 的「instanceId 必须 title 挂完整文本」断言必须因此变红。
    id: 'M50',
    name: '悬停失效：移动公众名下云主机列表的 instanceId 行不再挂 title',
    file: 'app/static/app.js',
    from: '<div title="${escapeHtml(iidLineText)}" style="font-size: 11px; color: #64748b; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(iidLineText)}</div>',
    to: '<div style="font-size: 11px; color: #64748b; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(iidLineText)}</div>',
    replaceAll: false,
  },
  {
    // 2026-09-25 第七轮（诚实性红线·后端侧）：空状态被默认成 off。
    // 后果：侧车没拿到状态时，界面会整齐地显示一屏「已关机」——全是假消息。
    // 组 22 的「空状态必须归 unknown」断言必须因此变红。
    // ⚠️ from 必须**单行**：desktop_list.py 是 CRLF 行尾，from 里写 \n 永远匹配不上
    //（本变异首版就是因此"未生效"，被 BROKEN 拦下 —— 见 skill 教训：变异字面量要与文件行尾一致）。
    // 8 空格缩进的这一行在本文件中唯一（末尾 4 空格缩进的兜底 unknown 不会命中）。
    id: 'M51',
    name: '诚实性红线：normalize_power_state 把空/未知状态默认成 off',
    file: 'app/ecloud_engine/desktop_list.py',
    from: '        return "unknown"',
    to: '        return "off"',
    replaceAll: false,
  },
  {
    // 2026-09-25 第七轮（文案回退）：把已删除的标题后缀加回移动公众监视板块。
    // 组 18 的「标题必须恰好以『移动公众 保活监视』结尾」反向断言必须因此变红。
    id: 'M52',
    name: '文案回退：把「· 分层明细见日志」后缀加回移动公众监视板块标题',
    file: 'app/static/app.js',
    from: '>📡 移动公众 保活监视</span>',
    to: '>📡 移动公众 保活监视 · 分层明细见日志</span>',
    replaceAll: false,
  },
  {
    // 2026-09-25 第七轮收尾（三平台口径回退）：把天翼云卡片栏目名改回旧名「名下云电脑」。
    // 组 22 已从"移动公众侧更名"升级为「三平台统一」，其全仓扫描
    // `!/名下云电脑/.test(stripComments(appJs))` 与天翼云标题锁必须因此变红。
    id: 'M53',
    name: '口径回退：天翼云卡片栏目名改回旧名「名下云电脑」（破坏三平台统一）',
    file: 'app/static/app.js',
    from: '<span>🖥️ 名下云主机 (${dList.length}台)</span>',
    to: '<span>🖥️ 名下云电脑 (${dList.length}台)</span>',
    replaceAll: false,
  },
  {
    // 2026-09-23 第八轮（G1 底座闸门：SCG / ZTE / ERROR 三分类互斥一次判定）。
    // 这不是假想缺陷：本组之前 `vm.vendor` 就**只用于界面展示**、从不守执行路径，
    // 等价于"闸门恒放行"——一台 SCG 机器每轮照样被 ZTE 握手盲拨。
    // 组 23 的「SCG / UNKNOWN 必须被拒绝」断言必须因此变红。
    id: 'M54',
    name: '闸门失效：底座闸门恒放行（SCG / UNKNOWN 也能盲拨 ZTE）',
    file: 'app/ydpc/product_route.js',
    from: "  if (route.supported === true) return { allow: true, reason: '' };",
    to: "  if (true) return { allow: true, reason: '' };",
    replaceAll: false,
  },
  {
    // 同轮：丢掉 spuCode 优先级 —— 精确复刻旧实现"只看 firm-auth"的判定，
    // 而 firm-auth 会把空闲的 ZTE 机器（cagIp 未下发）误判成 SCG。
    id: 'M55',
    name: '判定降级：丢掉 spuCode 优先级（ZTE 机器被 firm-auth 误判成 SCG）',
    file: 'app/ydpc/product_route.js',
    from: '  if (spu && SPU_ZTE.test(spu)) {',
    to: '  if (false && spu && SPU_ZTE.test(spu)) {',
    replaceAll: false,
  },
  {
    // 同轮（G3 诚实性红线）：把"从未证明"改口成"已被证明"。
    // 这正是本项目反复强调、却在此前**没有任何断言锁住**的那句措辞。
    id: 'M56',
    name: '诚实性红线：keepaliveProven 从恒 false 改成 true（宣称保活已被证明）',
    file: 'app/ydpc/ydpc_client.js',
    from: '      keepaliveProven: false,',
    to: '      keepaliveProven: true,',
    replaceAll: false,
  },
  {
    // 同轮（G2 失败分级）：把 soft 分类抽空 → 维护窗口 / 时长耗尽 / 限流全落进 hard
    // → "一维护就整轮熔断"的假故障（这三类必须按"只告警不熔断"处理）。
    id: 'M57',
    name: '分级失效：soft 分类被抽空（维护/时长耗尽被当成硬失败）',
    file: 'app/ydpc/product_route.js',
    from: "  for (const p of SOFT_PATTERNS) { if (p.test(s)) return 'soft'; }",
    to: "  for (const p of []) { if (p.test(s)) return 'soft'; }",
    replaceAll: false,
  },
  {
    // 2026-09-23 第九轮（G5 地址族路由 + IPv4/TLS 受控降级）。
    // 这不是假想缺陷：旧实现一律走 raw，IPv4 内层主机会在 sock 回调里抛未捕获异常。
    // 组 27 的「allowInsecure 门控」断言必须因此变红。
    id: 'M58',
    name: '降级失控：allowInsecure 门控被删（无条件 rejectUnauthorized=false）',
    file: 'app/ydpc/zte_cag_tls.js',
    from: '    if (allowInsecure) {',
    to: '    if (true) { // mutation：不再受 allowInsecure 约束',
    replaceAll: false,
  },
  {
    // 同轮：把"只对证书链缺陷降级"改成"任何错误都无条件重试一次并放宽校验"
    // —— 等价于把关闭证书校验变成默认行为。组 27 的行为断言（只拨 1 次）必须变红。
    id: 'M59',
    name: '降级失控：去掉证书链白名单判定（任何错误都重拨并放宽校验）',
    file: 'app/ydpc/zte_cag_tls.js',
    from: '    if (!CERT_CHAIN_ERROR_CODES.some((c) => code.includes(c))) throw err;',
    to: '    if (false) throw err; // mutation：任何错误都降级重试',
    replaceAll: false,
  },
  {
    // 同轮：把通用网络错误塞进"证书链缺陷白名单" —— 最常见的错法（顺手加 ECONNREFUSED
    // 让本地排查更"顺"）。组 27 的白名单纯度断言必须变红。
    id: 'M60',
    name: '白名单污染：把通用网络错误 ECONNREFUSED 塞进证书链白名单',
    file: 'app/ydpc/zte_cag_tls.js',
    from: "  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',",
    to: "  'ECONNREFUSED', // mutation：白名单被污染\n  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',",
    replaceAll: false,
  },
  {
    // 同轮：地址族判据失效 —— 回到"一切内层主机都当 IPv6 raw"，正是本轮要修的旧行为。
    // 组 26 的行为断言（IPv4→tls、主机名→reject）必须变红。
    id: 'M61',
    name: '地址族判据失效：一切内层主机都当 raw（IPv4 也被塞进 raw 拨号）',
    file: 'app/ydpc/product_route.js',
    from: "  if (bare.includes(':')) {",
    to: '  if (bare.length > 0) { // mutation：不再区分地址族',
    replaceAll: false,
  },
  {
    // 同轮：data 回调异常不再就地收敛 —— 复活"未捕获异常 + Promise 挂到超时"，
    // 让失败绕过 G2 分级。组 27 的"异常就地收敛"断言必须变红。
    id: 'M62',
    name: '异常失控：data 回调不再 try/catch 收敛（未捕获异常复活，绕过 G2 分级）',
    file: 'app/ydpc/zte_cag_tls.js',
    from: '      try { handleData(chunk); }\n      catch (e) { clearTimeout(timer); sock.destroy(); done(reject, e); }',
    to: '      handleData(chunk); // mutation：异常不再就地收敛',
    replaceAll: false,
  },
  {
    // 同轮：跨天清零的"同日短路"被删 —— 退化成"每次调用都清零"，当天 xN 永远停在 1，
    // 折叠形同虚设（用户看到的将是一长串各自 x1）。
    // 组 28 的行为断言（同一天内调用必须返回 0 且计数不变）必须变红。
    id: 'M63',
    name: '清零失控：去掉"跨天才清零"的判定（每次调用都把例行日志归 1，xN 永远 x1）',
    file: 'server.js',
    from: '  if (today === routineFoldDay) return 0;',
    to: '  if (false) return 0; // mutation：不再判断是否跨天（每次调用都清零）',
    replaceAll: false,
  },
  {
    // 同轮：清零范围越界 —— 连非例行日志（异常 / 业务事件）一起清，直接破坏取证红线。
    // 组 28 的"异常条目计数不得被跨天清零"断言必须变红。
    id: 'M64',
    name: '清零越界：跨天把非例行日志的计数也一起归 1（异常/业务条目被误改）',
    file: 'server.js',
    from: '    if (!routineFoldKey(entry.source, entry.message)) continue;',
    to: '    if (false) continue; // mutation：非例行日志也被清零',
    replaceAll: false,
  },
  {
    // 同轮：观测失效 —— 平台电源状态变化不再留证（回到"只存 app_config.json 最后一帧"）。
    // 组 29 的"状态变化必须留证"断言必须变红。
    id: 'M65',
    name: '观测失效：平台电源状态变化不再落日志（历史无法回放，真关机也看不出来）',
    file: 'app/ecloud/ecloud_client.js',
    from: '        if (rawPrev === null || rawPrev !== rawNow) {',
    to: '        if (false) { // mutation：平台电源状态变化不再留证',
    replaceAll: false,
  },
  {
    // 同轮：告警失效 —— 在线时长回退不再告警（02:01 那种"真关机"信号会被静默吞掉）。
    // 组 29 的"回退必须告警"断言必须变红。
    id: 'M66',
    name: '告警失效：在线时长回退不再告警（平台侧会话被重建时静默无感）',
    file: 'app/ecloud/ecloud_client.js',
    from: '        if (Number.isFinite(upPrev) && upPrev >= 0 && upNow < upPrev - UPTIME_REGRESSION_MIN_SEC) {',
    to: '        if (false) { // mutation：在线时长回退不再告警',
    replaceAll: false,
  },
  {
    id: 'M67',
    name: '重启空洞：去掉"无判定但有 vendor"的重建（_route 不落盘 ⇒ 闸门重启后 fail-open，SCG 机被 ZTE 盲拨）',
    file: 'app/ydpc/ydpc_client.js',
    from: '        if (!vm._route && vm.vendor) {',
    to: '        if (false) { // mutation：不再重建判定，重启后闸门形同虚设',
    replaceAll: false,
  },
  {
    // ───────────────────────────────────────────────────────────────────────
    // 2026-09-26 第十轮：SCG（深信服）第二套数据面。
    //
    // 【M68 的沿革】它原来锁的是"vendor=SCG 重建后必须**不**受支持"——那是 SCG 通道
    // 尚未实现时的口径。本轮 SCG 通道（app/ydpc/scg_keepalive.js）已落地，判定改为
    // `supported: true`，旧 `from` 文本随之消失。于是把它**顺势改指**到真正的红线：
    // 材料不全时的明确拒绝。**不能只删掉它** —— 那等于本轮静默让出一条旧缺口。
    // ───────────────────────────────────────────────────────────────────────
    id: 'M68',
    name: 'SCG 材料闸门失效：resolveScgMaterial 不再明确拒绝（带着半套材料去拨）',
    file: 'app/ydpc/scg_keepalive.js',
    from: '  if (missing.length) {',
    to: '  if (false) { // mutation：材料不全也放行，带着半套材料去拨',
    replaceAll: false,
  },
  {
    // 同轮：SCG 关校验复活 —— 最高危的一条（等于把 scAuthCode 走明文 TLS 且不验身份）。
    // 组 7 的指纹扫描 + 组 30 的 TLS 策略断言都必须因此变红。
    id: 'M69',
    name: 'SCG 关校验复活：TLS 选项写死 rejectUnauthorized:false（无条件关证书）',
    file: 'app/ydpc/scg_keepalive.js',
    from: 'rejectUnauthorized: !allowInsecure',
    to: 'rejectUnauthorized: false',
    replaceAll: false,
  },
  {
    // 同轮：严格先行被破坏 —— 第一次拨号就放宽校验，"白名单降级"退化成"默认降级"。
    id: 'M70',
    name: 'SCG 严格先行被破坏：首次拨号直接 allowInsecure=true（默认关校验）',
    file: 'app/ydpc/scg_keepalive.js',
    from: '    return await scgConnectOnce({ ...opts, allowInsecure: false });',
    to: '    return await scgConnectOnce({ ...opts, allowInsecure: true });',
    replaceAll: false,
  },
  {
    // 同轮：降级失控 —— 去掉白名单判定，任何错误（含 ECONNRESET / 超时）都重拨并放宽校验。
    // 组 30 的静态精确形断言与行为断言（只拨 1 次）都必须因此变红。
    id: 'M71',
    name: 'SCG 降级失控：去掉证书链白名单判定（任何错误都重拨并放宽校验）',
    file: 'app/ydpc/scg_keepalive.js',
    from: '    if (!CERT_CHAIN_ERROR_CODES.includes(code)) throw e;',
    to: '    if (false) throw e; // mutation：任何错误都降级重试',
    replaceAll: false,
  },
  {
    // 同轮：白名单污染 —— 最常见的错法（顺手加 ECONNREFUSED 让本地排查更"顺"）。
    id: 'M72',
    name: 'SCG 白名单污染：把通用网络错误 ECONNREFUSED 塞进 SCG 证书链白名单',
    file: 'app/ydpc/scg_keepalive.js',
    from: "  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',",
    to: "  'ECONNREFUSED', // mutation：白名单被污染\n  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',",
    replaceAll: false,
  },
  {
    // 同轮：帧头长度错一个字节 —— **不会有任何报错**，只会在真机上"连得上但永远收不到
    // 显示数据"，且看起来像"平台不给"。这正是最需要机械拦截的一类"静默错"。
    id: 'M73',
    name: 'SCG 帧长错位：Chuanyun 帧头由 24B 改成 20B（连得上但永远解不出帧）',
    file: 'app/ydpc/scg_keepalive.js',
    from: 'const SCG_FRAME_HEAD_SIZE = 24;',
    to: 'const SCG_FRAME_HEAD_SIZE = 20; // mutation：帧头长度错位',
    replaceAll: false,
  },
  {
    // 同轮：显示判据放宽 —— 把"发了 DISPLAY_INIT"当成"显示面已被证明"，
    // 于是界面可以合法地宣称"已观察到显示数据"。这是本项目反复强调的假保活声明形态。
    id: 'M74',
    name: 'SCG 显示判据放宽：只要发过 DISPLAY_INIT 就算"显示已证明"（假保活声明）',
    file: 'app/ydpc/scg_keepalive.js',
    from: '  return !!(p.displayInitSent && p.markReceived &&\n    (p.surfaceCreateReceived || p.drawCopyReceived));',
    to: '  return !!p.displayInitSent; // mutation：只要发过 DISPLAY_INIT 就算已证明',
    replaceAll: false,
  },
  {
    // 【2026-09-26 修订】原 M75 注入 sc-user-5e38ece5 —— 该 client_id 已随 CEM 控制面
    // （用户批准的保活路径）在 scg_keepalive.js 合法化，注入不再变红。改指到**仍然禁止**
    // 的指纹：伪造服务端 UA（cdpsdk-server）。它验证同一件事：
    // 组 7 的指纹扫描**确实**已覆盖 scg_keepalive.js（而不是只在名单里挂着）。
    id: 'M75',
    name: '红线注入：把伪造的服务端 UA（cdpsdk-server）注入 scg_keepalive.js',
    file: 'app/ydpc/scg_keepalive.js',
    from: "'use strict';",
    to: "'use strict';\nconst FORGED_UA = 'User-Agent: cdpsdk-server-1.0'; // mutation：伪造官方服务端身份",
    replaceAll: false,
  },
  {
    // 同轮：接线缺失 —— 数据面不再按 SCG 分流，一台 SCG 机器于是回落到 cagBootVm 盲拨，
    // 即历史症状「每 30s 报一次 cagIp 缺失，无法开机」。
    id: 'M76',
    name: 'SCG 接线缺失：数据面不再按 SCG 分流（回落 cagBootVm，复活 cagIp 缺失盲拨）',
    file: 'app/ydpc/ydpc_client.js',
    from: "          if (vm._route && vm._route.kind === 'SCG') {",
    to: '          if (false) { // mutation：SCG 不再分流，回落到 cagBootVm',
    replaceAll: false,
  },
  {
    // 同轮：通道名谎报 —— 把 SCG 也写成 raw ZTEC，界面上"另一套通道"被谎报成 ZTE。
    id: 'M77',
    name: 'SCG 通道名谎报：状态视图把 scg 也写成 raw ZTEC（把另一套通道谎报成 ZTE）',
    file: 'app/ydpc/ydpc_client.js',
    from: "        : (dpPath === 'scg' ? 'SCG · trunk+SPICE' : ''));",
    to: "        : (dpPath === 'scg' ? 'IPv6 · raw ZTEC' : ''));",
    replaceAll: false,
  },
  {
    // ───────────────────────────────────────────────────────────────────────
    // 2026-09-26 第十一轮：SCG 底座下的 UI 分叉（用户「下面的自动化保活开关下面的
    // 内容是不是也要变掉了」）。第二轮追加：用户要求把 SCG 下"按不动"的守护/开机
    // 控件与「自动开机守护」开关**整体删掉**（「都删掉吧」）—— 于是这几条从"锁 disabled
    // 占位"改写为"锁整块不渲染"，锁的仍是**假承诺的回归路径**。
    // ───────────────────────────────────────────────────────────────────────
    id: 'M78',
    name: 'SCG UI 回退：底座画像被写死 false（SCG 账号又用 ZTE 文案渲染开关区）',
    file: 'app/static/app.js',
    from: "    const _ydpcAllScg = vms.length > 0 && _ydpcVendors.length === 1 && _ydpcVendors[0] === 'SCG';",
    to: '    const _ydpcAllScg = false; // mutation：底座画像失效，SCG 又走 ZTE 文案',
    replaceAll: false,
  },
  {
    // 【2026-09-26 第三轮修订】SCG 开机真机打通，守护块恢复恒渲染 —— 原"渲染出摆设"的
    // 变异作废，改指新的失真红线：把 CEM 文案改回"SCG 机无效"的过时假承诺。
    // 组 31 的「过时假承诺文案禁止复活」断言必须因此变红。
    id: 'M79',
    name: 'SCG UI 失真复活：守护块文案改回「SCG 机无效」的过时假承诺',
    file: 'app/static/app.js',
    from: '🛡️ 自动开机守护（CAG/CEM 通道 · 按底座自动分流）',
    to: '🛡️ 自动开机守护（CAG 通道 · SCG 机无效）',
    replaceAll: false,
  },
  {
    // 同轮·第二轮：增量轮询不再判守护胶囊是否存在 ⇒ 若有人放开 SCG 渲染，就会凭空
    // 造出一个"幽灵控件"（元素不存在却被无脑覆写）。存在性判断是最后一道拦网。
    id: 'M80',
    name: 'SCG UI 幽灵控件：增量轮询不再判守护胶囊是否存在',
    file: 'app/static/app.js',
    from: 'if (pAutoBoot) {',
    to: 'if (pAutoBoot || true) {',
    replaceAll: false,
  },
  {
    // 【2026-09-26 第三轮修订】SCG 开机按钮已恢复且走 CEM —— 原"摘掉 SCG 判据"的变异
    // 作废，改指新的失真红线：把 SCG 开机按钮的 CEM 文案改回 CAG（误导走不通的通道）。
    // 组 31 的「SCG 机器开机按钮必须标明 CEM 通道」断言必须因此变红。
    id: 'M81',
    name: 'SCG UI 谎报：开机按钮的 CEM 文案改回 CAG（深信服机没有 CAG 通道）',
    file: 'app/static/app.js',
    from: '通过 CEM 官方通道拉起这台云电脑（深信服底座 · 已真机验证）',
    to: '通过 CAG 官方通道拉起这台云电脑',
    replaceAll: false,
  },
  {
    // 同轮（诚实性）：对**尚未被证明**的 SCG 通道沿用 ZTE 的「真保活」措辞。
    id: 'M82',
    name: 'SCG UI 越界下结论：SCG 数据面开关沿用「真保活」措辞（未证明却说已证明）',
    file: 'app/static/app.js',
    from: "'📡 数据面保活（SCG · trunk+SPICE）'",
    to: "'📡 数据面保活（SCG · trunk+SPICE · 真保活）'",
    replaceAll: false,
  },
  {
    // 同轮：前端按名称字样猜底座（"家庭"就判 SCG）—— 正是 G1 修掉的那类猜测。
    id: 'M83',
    name: 'SCG UI 猜测复活：前端按名称字样猜底座（"家庭"就判 SCG）',
    file: 'app/static/app.js',
    from: "    const _isScgVm = (v) => String((v && v.vendor) || '').toUpperCase() === 'SCG';",
    to: "    const _isScgVm = (v) => /家庭|SCG/i.test(String((v && v.vmName) || '')); // mutation：按名称猜底座",
    replaceAll: false,
  },
  {
    // 【2026-09-26 第三轮修订】SCG 守护/开机控件已恢复渲染 —— 原"去掉 _isScgVm 抑制"的
    // 变异作废（抑制已删），改指新的失真红线：守护胶囊的 autoBootEnabled 开关接线被拆
    // （控件还在却点了没反应）。组 31 的接线断言必须因此变红。
    id: 'M84',
    name: '守护控件失能：单机守护胶囊的 autoBootEnabled 开关接线被拆',
    file: 'app/static/app.js',
    from: "onclick=\"toggleVmFeature('${acc.id}', '${usid}', 'autoBootEnabled'",
    to: "data-mutation=\"autoBootEnabled wiring removed\"",
    replaceAll: false,
  },
  {
    // ───────────────────────────────────────────────────────────────────────
    // 2026-09-26 第十二轮：用户现场日志暴露的两个真实缺陷（见回归组 32）。
    // ───────────────────────────────────────────────────────────────────────
    // 假成功复活：把 runWithGrade 的「不抛但 success:false」识别拆掉 ⇒ 关机机又被打成
    // 「ZTEC CAG TCP 握手保活成功」（用户看到的那条假日志）。
    id: 'M85',
    name: '假成功复活：runWithGrade 不再识别「不抛异常但 success:false」',
    file: 'app/ydpc/ydpc_client.js',
    from: '              r && r.success === false',
    to: '              false && r.success === false',
    replaceAll: false,
  },
  {
    // 判据分叉复活：保活循环退回就地重写的关机判据（漏掉「未开机」与状态码 0）
    // ⇒ 同一台机器"卡片说已关机、循环说在运行"，于是照打心跳与握手。
    id: 'M86',
    name: '判据分叉复活：runCycle 退回就地重写的关机判据（漏「未开机」/状态码 0）',
    file: 'app/ydpc/ydpc_client.js',
    from: '          const isVmOff = isYdpcVmOff(vm);',
    to: "          const isVmOff = String(vm.vmStatus || '').includes('关机') || vm.vmStatusCode === 23 || vm.vmStatusCode === 16;",
    replaceAll: false,
  },
  {
    // 「关机待命」被谎报成「已完成」：把 sendHeartbeat 的关机返回改回 success:true
    // （与 pingCag 的契约不一致，正是它让 SOHO 分支把"待命"算进了 doneParts）。
    id: 'M87',
    name: '假成功复活：sendHeartbeat 关机返回改回 success:true（待命谎报成完成）',
    file: 'app/ydpc/ydpc_client.js',
    from:
      '      // 【2026-09-26 修复·假成功】"没做事"必须报 success:false —— 与 pingCag 统一契约。\n' +
      '      // 旧写法返回 success:true，调用方于是把"待命"记成了"完成"。\n' +
      "      return { success: false, message: '云电脑处于关机状态' };",
    to: "      return { success: true, message: '云电脑处于关机状态' };",
    replaceAll: false,
  },
  {
    // 成功日志的护栏被拆：CAG 调用点不再排除 skipped ⇒ 没拨号也照样打 success 日志。
    id: 'M88',
    name: '假成功复活：CAG 调用点不再排除 skipped（没拨号也打「握手保活成功」）',
    file: 'app/ydpc/ydpc_client.js',
    from: '            } else if (!cagFail.skipped) {',
    to: '            } else {',
    replaceAll: false,
  },
  {
    // 反向失真：前端不再识别"未开机 ⇒ 本次未执行" ⇒ 把"待命"渲染成「握手失败/心跳异常」。
    // （与 M85–M88 是一对：假成功与假故障都是失真，红线两侧都要守。）
    // 【2026-09-26 更新】`from` 随源码升级（新增"未发起 / 无 CAG 通道"两类跳过文案）——
    // 旧 from 已失配，若不同步改就会判 BROKEN（与"漏网"是两回事）。
    id: 'M89',
    name: '假故障：前端只认「关机」，SCG/材料缺失的"未发起"被渲染成失败',
    file: 'app/static/app.js',
    from: "    /关机|未开机|未运行|未发起|无 CAG 通道/.test(String(data.message || ''));",
    to: "    /关机|未开机|未运行/.test(String(data.message || ''));",
    replaceAll: false,
  },
  {
    // 假活跃复活：数据面"在场"判据退回只看 task.running ⇒ 一个**每轮都抛错、从未建立
    // 过隧道**的任务也算在场 ⇒ 控制面（SOHO 心跳 + CAG 握手）被永久压住 ⇒
    // 这台机器一条保活动作都没有，被平台按"无活动"关机（用户现场："一直自动关机"）。
    id: 'M90',
    name: '假活跃复活：isDataPlaneActive 退回只看 task.running（失败任务也当"在场"）',
    file: 'app/ydpc/ydpc_client.js',
    from: '    return (task.failStreak || 0) < DATA_PLANE_FAIL_LIMIT;',
    to: '    return true;',
    replaceAll: false,
  },
  {
    // 失败不计数 ⇒ 永远不会降级 ⇒ 控制面永远拿不回保活权（假活跃的另一半）。
    id: 'M92',
    name: '假活跃复活：失败计数不再累加（连续失败也无法触发交还控制面）',
    file: 'app/ydpc/ydpc_client.js',
    from: '    task.failStreak = (task.failStreak || 0) + 1;',
    to: '    task.failStreak = (task.failStreak || 0);',
    replaceAll: false,
  },
  {
    // 材料守卫被拆 ⇒ 字面量 "undefined" 又成了主机名，真的去解析一个叫 undefined 的主机
    // ⇒ `getaddrinfo ENOTFOUND undefined`（用户贴出的原句），并被 hard 分档报成链路故障。
    id: 'M91',
    name: 'undefined 当主机名复活：performCagAuthHold 拆掉材料守卫',
    file: 'app/ydpc/cag_client.js',
    from:
      "  const cagHostRaw = String(a.cagIp || a.cagHost || '').trim();\n" +
      '  if (!cagHostRaw) {\n' +
      "    const err = new Error('该机器未下发 CAG 连接材料（cagIp 缺失），本次不发起 CAG 握手');\n" +
      "    err.code = 'CAG_MATERIAL_MISSING';\n" +
      '    return Promise.reject(err);\n' +
      '  }',
    to: '  const cagHostRaw = String(a.cagIp || a.cagHost);',
    replaceAll: false,
  },
  {
    // 守卫"字还在、但不再拦截"：把条件改成恒假 ⇒ 静态断言全绿，只有行为断言能抓到。
    // （这条变异存在的意义正是证明"必须有行为断言"，否则本类缺陷会永久隐身。）
    id: 'M93',
    name: '守卫失效：pingCag 的 SCG 前置拒绝被改成 if (false)（字符串仍在，拦截已失效）',
    file: 'app/ydpc/ydpc_client.js',
    from: "    if (currentVm && (currentVm.vendor === 'SCG' ||",
    to: "    if (false && (currentVm.vendor === 'SCG' ||",
    replaceAll: false,
  },
  {
    // 同上：材料缺失改成抛错（而不是 return 跳过）⇒ 每轮被记成真失败并弹 error 告警。
    id: 'M94',
    name: '守卫失效：pingCag 的材料缺失前置拒绝被改成 if (false)',
    file: 'app/ydpc/ydpc_client.js',
    from: '      if (!firmAuth || !(firmAuth.cagIp || firmAuth.cagHost)) {',
    to: '      if (false) {',
    replaceAll: false,
  },
  {
    // 措辞失真复活：SCG 机的降级留证写回"（SOHO 心跳 + CAG 握手）" ⇒
    // 声称一条**在 SCG 上不存在**的保活通道正在保活（与"假成功"同源的失真）。
    id: 'M95',
    name: '措辞失真复活：SCG 降级留证改回声称"CAG 握手"在保活（该通道不存在）',
    file: 'app/ydpc/ydpc_client.js',
    from: "          ? '（SCG 底座无 CAG 握手通道，仅剩 SOHO 心跳）'",
    to: "          ? '（SOHO 心跳 + CAG 握手）'",
    replaceAll: false,
  },
  {
    // 底座标签不落 task ⇒ 所有底座都退化成 ZTE 措辞 ⇒ SCG 机又被宣称有 CAG 握手。
    id: 'M96',
    name: '措辞失真复活：task.routeKind 不再按底座写入（SCG 机退回 ZTE 措辞）',
    file: 'app/ydpc/ydpc_client.js',
    from: "      routeKind: (vm && vm._route && vm._route.kind) || ''",
    to: "      routeKind: ''",
    replaceAll: false,
  },
  {
    // "零应答"守卫字还在、但不再拦截 ⇒ 空应答掉进"字节不符"分支，
    // 甚至去读 undefined 的首字节（旧代码正是把它兜底成 0，编造出 byte[0]=0x0）。
    // 静态断言抓不到这种"条件被改假"，只有真起一个静默 TCP 服务端的行为断言能抓到。
    id: 'M97',
    name: '守卫失效：SCG"零应答"分支被改成 if (false)（空应答又被当成字节不符）',
    file: 'app/ydpc/scg_keepalive.js',
    from: '    if (!resp.length) {',
    to: '    if (false && !resp.length) {',
    replaceAll: false,
  },
  {
    // 失真复活：把"零应答"的文案改回编造出来的 byte[0]=0x0 ⇒ 排查方向被带偏。
    id: 'M98',
    name: '失真复活：SCG 零应答文案改回"byte[0]=0x0"（编造一个不存在的字节）',
    file: 'app/ydpc/scg_keepalive.js',
    from: "        'SCG auth 无应答：超时内未收到任何字节（服务端未回包或连接已被断开）'",
    to: "        'SCG auth 失败：byte[0]=0x0'",
    replaceAll: false,
  },
  {
    // ───────────────────────────────────────────────────────────────────────
    // 2026-09-26 第十二轮：SCG 开机能力落地（真机验证：畅享版 getConnectInfo 触发开机
    // ~77s 后运行中）。两条新红线锁住"按钮 → 后端 → CEM"这条链不被拆。
    // ───────────────────────────────────────────────────────────────────────
    id: 'M99',
    name: 'SCG 开机接线被拆：bootVmViaCag 的 SCG 分支退回"暂不支持开机"的旧拒绝',
    file: 'app/ydpc/ydpc_client.js',
    from: '      return await this.bootVmViaCem(userServiceId, accName, firmAuth);',
    to: "      throw new Error('SCG 底座暂不支持自动开机'); // mutation：CEM 开机被拆",
    replaceAll: false,
  },
  {
    id: 'M100',
    name: 'SCG 冷启动超时回退：getConnectInfo 超时从 120s 退回 20s（把"正在开机"误判成失败）',
    file: 'app/ydpc/scg_keepalive.js',
    from: 'timeoutMs: 120000',
    to: 'timeoutMs: 20000 /* mutation：冷启动等待不足，会把开机中的机器误判为失败 */',
    replaceAll: false,
  },
  {
    // ───────────────────────────────────────────────────────────────────────
    // 2026-09-27 第十三轮：504 在途语义 + 独立核验（真机：点开机 → CEM 504 →
    // 机器照样被拉起；旧实现报"开机失败"，属虚报失败）。
    // ───────────────────────────────────────────────────────────────────────
    id: 'M101',
    name: '504 在途语义被拆：getConnectInfo 的 5xx 不再被识别为可重试（机器被拉起却报失败）',
    file: 'app/ydpc/scg_keepalive.js',
    from: 'if (res.status >= 500) {',
    to: 'if (false) { // mutation：504 不再按"在途"处理',
    replaceAll: false,
  },
  {
    id: 'M102',
    name: '独立核验被拆：开机调用方不再走列表接口核实（读不到"已运行"就敢报失败）',
    file: 'app/ydpc/ydpc_client.js',
    from: 'const verified = await this._verifyVmRunning(userServiceId);',
    to: 'const verified = true; /* mutation：独立核验被拆，不再核实真实状态 */',
    replaceAll: true,
  },
  {
    id: 'M103',
    name: '在途语义退化：预算耗尽不再返回 pending（开机在途被当成致命错误抛出）',
    file: 'app/ydpc/scg_keepalive.js',
    from: 'ok: false, pending: true, reason: e.message, readyStatus: null,',
    to: 'ok: false, pending: false, reason: e.message, readyStatus: null, /* mutation：丢掉在途语义 */',
    replaceAll: false,
  },
  {
    // ───────────────────────────────────────────────────────────────────────
    // 2026-09-27 第十四轮：大众版 L2 静默会话信号（用户要求：默认执行 / 无 UI / 无日志）。
    // ───────────────────────────────────────────────────────────────────────
    id: 'M104',
    name: '静默信号缺失：keepalive_once 不再附带 updateSessionStatus/pushConnectEventData',
    file: 'app/ecloud_engine/desktop_session.py',
    from: 'for signal in (self.renew_session_status, self.report_connect_event):',
    to: 'for signal in ():  # mutation：静默信号被摘掉',
    replaceAll: false,
  },
  {
    id: 'M105',
    name: '静默破功：会话信号方法里写日志（用户要求"日志不显示"）',
    file: 'app/ecloud_engine/desktop_session.py',
    from: '        self.http.post(config.Endpoint.UPDATE_SESSION_STATUS, {',
    to: '        log.warning("mutation: 静默破功"); self.http.post(config.Endpoint.UPDATE_SESSION_STATUS, {',
    replaceAll: false,
  },
  {
    // ───────────────────────────────────────────────────────────────────────
    // 2026-09-27 第十五轮：accessToken 主动续期（平台 TTL≈30 分钟，真机统计证实）。
    // ───────────────────────────────────────────────────────────────────────
    id: 'M106',
    name: '续期周期倒退：从 25 分钟改回 40 分钟（晚于平台 ~30 分钟 TTL，401 照旧）',
    file: 'app/ecloud/ecloud_client.js',
    from: 'parseInt(process.env.ECLOUD_TOKEN_REFRESH_MS, 10) || 25 * 60 * 1000',
    to: 'parseInt(process.env.ECLOUD_TOKEN_REFRESH_MS, 10) || 40 * 60 * 1000 /* mutation：晚于 TTL */',
    replaceAll: false,
  },
  {
    id: 'M107',
    name: '续期日志误导：quiet 失效，主动续期又落"重登成功"（无 401 却像在救火）',
    file: 'app/ecloud_engine/sidecar.py',
    from: 'if not params.get("quiet"):',
    to: 'if True:  # mutation：quiet 失效',
    replaceAll: false,
  },
  {
    // ───────────────────────────────────────────────────────────────────────
    // 2026-09-28 第十六轮：移动公众开机能力（operate=available 官方通道）。
    // ───────────────────────────────────────────────────────────────────────
    id: 'M108',
    name: '开机取值失真：poweron 映射改成后端不认识的 startup（开机能力实际失效）',
    file: 'server.js',
    from: "poweron: 'available', boot: 'available'",
    to: "poweron: 'startup', boot: 'available' /* mutation：后端不认识 startup，开机必失败 */",
    replaceAll: false,
  },
  {
    id: 'M109',
    name: '开关机判定退回单一平台信号：徽章不再用合成口径（平台撒谎时界面跟着错）',
    file: 'app/static/app.js',
    from: "const powerState = String((view && view.powerState) || d.powerState || '').toLowerCase();",
    to: "const powerState = String(d.powerState || '').toLowerCase(); /* mutation：退回单一平台信号 */",
    replaceAll: false,
  },
  {
    // ───────────────────────────────────────────────────────────────────────
    // 2026-09-28 第十七轮：30 天免登录（会话说盘 / 登出吊销 / 过期不恢复）。
    // ───────────────────────────────────────────────────────────────────────
    id: 'M110',
    name: '免登录泄漏：所有会话都落盘（未勾选的公共电脑会话也被持久化）',
    file: 'app/auth_manager.js',
    from: 'if (!s.remember) continue;',
    to: 'if (false) continue; /* mutation：所有会话都落盘 */',
    replaceAll: false,
  },
  {
    id: 'M111',
    name: '会话永不过期：恢复时不再校验 30 天窗口（过期 token 复活）',
    file: 'app/auth_manager.js',
    from: 'if (Date.now() > s.expiresAt) continue; // 过期不恢复（30 天窗口到期）',
    to: 'if (false) continue; /* mutation：不校验过期 */',
    replaceAll: false,
  },
  {
    id: 'M112',
    name: '登出退不掉：登出端点不再吊销服务端会话（重启后旧 token 复活）',
    file: 'server.js',
    from: 'authManager.destroySession(session.token);',
    to: '/* mutation：登出不再吊销会话 */',
    replaceAll: false,
  },
  {
    // ───────────────────────────────────────────────────────────────────────
    // 2026-09-28 第十八轮：移动公众自动开机守护（双开关 + 冷却 + 合成门禁）。
    // ───────────────────────────────────────────────────────────────────────
    id: 'M113',
    name: '守护失守·单机门禁：显式关闭的单机守护也被无视（关了还开）',
    file: 'app/ecloud/ecloud_client.js',
    from: 'if (d.autoBootEnabled === false) continue;',
    to: 'if (false) continue; /* mutation：单机开关门禁被拆 */',
    replaceAll: false,
  },
  {
    id: 'M114',
    name: '守护失守·盲开：不再校验合成判定（向运行中的机器也下发开机）',
    file: 'app/ecloud/ecloud_client.js',
    from: "if (st.state !== 'off') continue;",
    to: 'if (false) continue; /* mutation：不校验开关机状态，盲开 */',
    replaceAll: false,
  },
  {
    id: 'M115',
    name: '守护失守·冷却被拆：不再做同机 10 分钟冷却（接口刷屏风险）',
    file: 'app/ecloud/ecloud_client.js',
    from: 'if (Date.now() - (d._lastAutoBootAt || 0) < ECLOUD_AUTOBOOT_COOLDOWN_MS) continue;',
    to: 'if (false) continue; /* mutation：冷却被拆 */',
    replaceAll: false,
  },
  {
    // 2026-09-28 用户拍板：守护双开关均默认开启。本变异把它翻回"默认关闭"口径。
    id: 'M116',
    name: '默认开启倒退：ecloud 守护账号级门禁改回 === true（用户没勾就不守护）',
    file: 'app/ecloud/ecloud_client.js',
    from: 'if (this.account.features?.autoBoot !== false) {',
    to: 'if (this.account.features?.autoBoot === true) { /* mutation：默认开启倒退 */',
    replaceAll: false,
  },
  {
    // 2026-09-28 修复：抽取 _autoBootArmed 时漏改的关机分支 —— 悬空引用 accAutoBootOn/vmAutoBootOn
    // 会抛 ReferenceError 中断整账号巡检（抽取重构的真实伴生缺陷，被组 34 的两条新断言捕获）。
    id: 'M117',
    name: '悬空引用复活：关机分支的"未武装原因"改回引用已删除的 accAutoBootOn/vmAutoBootOn',
    file: 'app/ydpc/ydpc_client.js',
    from: "const why = this._autoBootArmed(vm) ? '当前套餐时长受限' : '未开启自动开机守护';",
    to: "const why = (!accAutoBootOn || !vmAutoBootOn) ? '当前套餐时长受限' : '未开启自动开机守护';",
    replaceAll: false,
  },
  {
    // 2026-09-28 修复：公众开关盒误用爱家变量 _ydpcVendors（块级 const，公众分支不可见）
    // ⇒ 渲染 ecloud 卡片即 ReferenceError（界面白块）。被组 34 的"渲染作用域隔离"断言捕获。
    id: 'M118',
    name: '渲染作用域越界：公众守护 checkbox 引用爱家的 _ydpcVendors（卡片渲染即 ReferenceError）',
    file: 'app/static/app.js',
    from: "${f.autoBoot !== false ? 'checked' : ''}",
    to: "${(f.autoBoot !== undefined ? f.autoBoot !== false : _ydpcVendors.includes('SCG')) ? 'checked' : ''}",
    replaceAll: false,
  },
  {
    // 2026-09-28 修复反向：爱家账号级 checkbox 丢掉底座分叉（纯 ZTE 账号界面显示为开，
    // 与后端 _autoBootArmed 的"纯 ZTE 默认关"不一致）。被组 34 的 _ydpcVendors.includes('SCG') 断言捕获。
    id: 'M119',
    name: '口径漂移：爱家账号级守护 checkbox 丢掉 SCG 分叉（前端显示与后端 _autoBootArmed 不一致）',
    file: 'app/static/app.js',
    from: "(f.autoBoot !== undefined ? f.autoBoot !== false : _ydpcVendors.includes('SCG'))",
    to: 'f.autoBoot !== false',
    replaceAll: false,
  },
  {
    // 2026-09-28 用户拍板「公开常量直接打包进去」后新增：删除内置兜底来源
    // ⇒ 全新部署（没有覆盖文件、没有环境变量）会因凭据缺失直接不可用，
    // "开箱即用"的行为断言必须因此变红。
    id: 'M120',
    name: '开箱即用失守：内置公开常量不再参与加载（新部署必须自备凭据文件）',
    file: 'app/ecloud_engine/config.py',
    from: '    for label, path in (("覆盖文件", cred_file), ("内置公开常量", bundled_file)):',
    to: '    for label, path in (("覆盖文件", cred_file),):',
    replaceAll: false,
  },
  {
    // 同轮：优先级倒退 —— 环境变量不再是最高优先来源（用户显式注入被内置常量/覆盖文件压住）。
    // 哨兵行为断言（ECLOUD_ACCESS_KEY / ECLOUD_SECRET_KEY 必须原样生效）必须因此变红。
    id: 'M121',
    name: '优先级倒退：环境变量不再最优先（显式注入被内置常量压住）',
    file: 'app/ecloud_engine/config.py',
    from: '    ak = os.environ.get("ECLOUD_ACCESS_KEY")',
    to: '    ak = None',
    replaceAll: false,
  },
];

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 沙箱构造：整树复制（只排除与源码无关的目录）
//
// 【2026-09-23 修复 · 重要】这里原先是一份手工维护的 SRC_FILES 清单。组 11 给回归测试网
// 新增 `read('app/persist_log.js')` 之后清单没同步，导致沙箱里的回归脚本在**读取阶段就
// ENOENT 崩溃**（退出码非 0，但不是任何断言失败）→ 12 项变异全部被误判为"被捕获"，
// 整个变异验证退化成**假 PASS**（一份永远不会真正变红的测试网）。
//
// 教训：变异验证的判据必须是"**断言**变红"，且沙箱必须自证可运行。
// 现在改为：① 整树复制，从机制上消除"文件清单漂移"；② 前置自检（未变异沙箱必须全绿）；
// ③ 只认"断言失败"，脚本崩溃会被判为 BROKEN 而不是 PASS。
// ---------------------------------------------------------------------------
const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'analysis', '.workbuddy', '.workbuddy-ai', 'data', 'tests', '.github', '.vscode'
]);
const IGNORE_FILES = new Set(['~srv.log', '~srv2.log', '~srv_run.log', 'repro_out.txt', 'status_out.txt']);

function copyTree(srcDir, dstDir) {
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      const to = path.join(dstDir, e.name);
      fs.mkdirSync(to, { recursive: true });
      copyTree(path.join(srcDir, e.name), to);
    } else {
      if (IGNORE_FILES.has(e.name)) continue;
      const to = path.join(dstDir, e.name);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(srcDir, e.name), to);
    }
  }
}

// 沙箱根目录放在**系统临时目录**（不在仓库内）。两个原因：
//   ① 仓库在工作区里被文件监听器盯着，整树增删会被反复扫描（实测比 tmp 慢约 15 倍）；
//   ② 更要紧的是，留在仓库里时出现过**交叉污染**：上一次变异创建的产物没有被删干净，
//      被下一次变异继承（曾在 M8 的沙箱里发现 M7 新建的文件），随后整轮静默挂死。
// 现在改为「**每个变异一个全新目录**」——从机制上不可能继承任何残留。
const SANDBOX_ROOT = path.join(os.tmpdir(), 'ctyun-mutation-' + process.pid);

function freshSandbox(tag) {
  const dir = path.join(SANDBOX_ROOT, String(tag));
  fs.mkdirSync(dir, { recursive: true }); // 全新路径，无需（也不依赖）先删除
  copyTree(ROOT, dir);
  // 自证：拷贝必须完整，否则后续所有「被捕获 / 漏网」的结论都不可信
  for (const must of ['server.js', 'package.json', path.join('app', 'ydpc', 'ydpc_client.js')]) {
    if (!fs.existsSync(path.join(dir, must))) {
      throw new Error(`沙箱拷贝不完整：缺少 ${must}（源=${ROOT}，目标=${dir}）`);
    }
  }
  return dir;
}

function runRegression(sandboxDir) {
  // 【2026-09-23 修复·重要】必须给沙箱内的回归运行加**硬超时**。
  // 实测：一次 `npm run test:mutation` 曾在第 2 个沙箱处静默挂死 6 分钟以上（零输出、
  // 无子进程），因为 spawnSync 默认永不超时 —— 一个挂死的子进程会让整条发布闸门
  // 无限期等下去，表现为"CI 卡住"而不是"CI 失败"，极难排查。
  // 现在：超时即杀子进程并判定为 BROKEN（不是 PASS），同时把超时原因写进报告。
  const REG_TIMEOUT_MS = Math.max(30000, parseInt(process.env.CTYUN_MUTATION_TIMEOUT_MS, 10) || 90000);
  const r = spawnSync(NODE, [path.join(ROOT, 'tests', 'regression.test.js')], {
    encoding: 'utf8',
    timeout: REG_TIMEOUT_MS,
    env: { ...process.env, CTYUN_TEST_ROOT: sandboxDir },
  });
  const timedOut = !!r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM' || r.signal === 'SIGKILL');
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), timedOut, timeoutMs: REG_TIMEOUT_MS };
}

/** 判定测试网是否**以断言失败**的方式变红（崩溃不算"守住"） */
function hasAssertionFailure(output) {
  return /^\s*FAIL\s+/m.test(output);
}

/**
 * 【2026-09-26 修复 · 重要】"退出码 0" 不足以证明测试网真的跑过。
 *
 * 现场成因：回归测试里 `await new Promise(res => srv.close(res))` 的回调**永不触发**
 * （本地 server 的 socket 停在半开态）⇒ 事件循环耗尽 ⇒ Node **以退出码 0 静默退出**，
 * stdout 一个字节都没有。此时 `code === 0` 与"192 项全绿"**完全无法区分**：
 * 前置自检会放行、末尾基线会判"全绿"，整条变异闸门就此在一张**从未跑过**的测试网上
 * 得出"验证通过"——与"假 PASS"同源。
 * ⇒ 除退出码外，必须要求输出里存在**汇总行**，且通过数不低于预期下限。
 */
const MIN_EXPECTED_PASSES = 150;

function summarize(output) {
  const m = String(output || '').match(/通过\s+(\d+)\s+项，失败\s+(\d+)\s+项/);
  if (!m) return { ran: false, passed: 0, failed: 0 };
  return { ran: true, passed: Number(m[1]), failed: Number(m[2]) };
}

/** 测试网是否"真跑过"（有汇总行且通过数达标） */
function ranForReal(output) {
  const s = summarize(output);
  return s.ran && s.passed >= MIN_EXPECTED_PASSES;
}

function firstFailingAssertion(output) {
  const m = output.match(/^\s*FAIL\s+(.+)$/m);
  if (m) return m[1].trim();
  const crash = output.match(/^(?:Error|TypeError|ReferenceError|SyntaxError|RangeError)[:\s].*$/m);
  if (crash) return `（脚本崩溃，非断言失败）${crash[0].trim()}`;
  return '(未匹配到 FAIL 行)';
}

// ---------------------------------------------------------------------------
// 前置自检：未施加任何变异的沙箱必须"全绿"。
// 若这里就不绿，说明测试网在隔离环境中根本无法执行 —— 后面所有"被捕获"都不可信，
// 必须立刻中止，而不是产出一份 12/12 的假报告。
// ---------------------------------------------------------------------------
{
  const probe = freshSandbox('preflight');
  const { code, out, timedOut, timeoutMs } = runRegression(probe);
  fs.rmSync(probe, { recursive: true, force: true });
  if (timedOut) {
    console.error(`前置自检失败：未施加任何变异的沙箱回归运行**超时**（>${timeoutMs}ms）—— 变异结论不可信。`);
    console.error('最常见原因：沙箱里缺少测试网会 require() 的资源（如 node_modules），导致子进程挂死。');
    console.error('--- 超时前的沙箱基线输出（末尾 2000 字符）---');
    console.error(out.slice(-2000));
    process.exit(1);
  }
  if (code !== 0) {
    console.error('前置自检失败：未施加任何变异的沙箱竟然不绿 —— 变异结论不可信。');
    console.error('最常见原因：沙箱缺少测试网会 read()/require() 的文件，导致脚本崩溃而非断言失败。');
    console.error('--- 沙箱基线输出（末尾 2000 字符）---');
    console.error(out.slice(-2000));
    process.exit(1);
  }
  // 【2026-09-26】退出码 0 也可能是"根本没跑"（静默退出、零输出）。
  // 必须有汇总行为证，否则后面所有"被捕获"都建立在一张没跑过的测试网上。
  if (!ranForReal(out)) {
    const s = summarize(out);
    console.error('前置自检失败：沙箱回归虽然退出码 0，但**没有产出有效的汇总行** ——');
    console.error(`  汇总行存在=${s.ran}，通过数=${s.passed}（下限 ${MIN_EXPECTED_PASSES}），输出长度=${String(out).length}`);
    console.error('  这等价于"测试网根本没有跑完"，绝不能当成"全绿"。');
    console.error('  已见成因：回归测试里 await srv.close(cb) 的回调永不触发（socket 半开）⇒');
    console.error('            Node 事件循环耗尽后以退出码 0 静默退出，stdout 为空。');
    console.error('--- 沙箱基线输出（末尾 2000 字符）---');
    console.error(String(out).slice(-2000));
    process.exit(1);
  }
}


// ---------------------------------------------------------------------------

const results = [];
let broken = 0;

console.log(`变异验证开始：共 ${MUTATIONS.length} 项，逐项在沙箱副本中重种并运行回归测试网`);
console.log(`（单轮沙箱回归硬超时 ${Math.max(30000, parseInt(process.env.CTYUN_MUTATION_TIMEOUT_MS, 10) || 90000)}ms，每一项完成即打印进度）`);

/**
 * 记录并**立刻**打印一条结论。
 * 【2026-09-23】原先所有结论都攒在数组里、跑完才一次性打印 —— 一旦中途挂死，
 * 日志就是一个 0 字节文件，完全不知道卡在哪一项。现在改为流式输出。
 */
function report(line) {
  results.push(line);
  console.log(line);
}

for (const mut of MUTATIONS) {
  const t0 = Date.now();
  // 阶段级进度：一旦某轮挂死，日志最后一行就能直接指出卡在哪一步
  // （同步 fs 调用挂死时事件循环被占住，任何定时器看门狗都不会触发，只能靠这种"面包屑"）。
  const stage = (s) => console.log(`       · ${mut.id} ${s} (+${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  stage('拷贝沙箱…');
  const sandbox = freshSandbox(mut.id);
  stage('沙箱就绪，施加变异…');

  // 可选：向沙箱"新增"文件（用于验证"该文件必须不存在"类断言）
  if (Array.isArray(mut.createFiles)) {
    for (const cf of mut.createFiles) {
      const dst = path.join(sandbox, cf.path);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, cf.content, 'utf8');
    }
  }

  let changed = false;
  // 【2026-09-24 修正】原判据是 `mut.from && mut.to`，而 `to` 为**空串**时是 falsy
  // → 「删除型变异」（把某段代码整段删掉，正是本次 M15 要模拟的"白名单漏列"形态）
  //   会被整体跳过，并被误报为「未找到目标文本」——文本明明在，结论却是错的。
  // 变异闸门是这套测试网的最后一道防线，它自己的误报必须优先修掉。
  // 现在只要求 `to` **已声明**（可为空串），`from` 仍必须非空且必须命中。
  if (mut.file && mut.from && mut.to !== undefined) {
    const target = path.join(sandbox, mut.file);
    if (!fs.existsSync(target)) {
      if (mut.optional) {
        report(`  SKIP   ${mut.id}  ${mut.name}\n         目标文件不存在（可选变异），跳过`);
        continue;
      }
      broken++;
      report(`  BROKEN ${mut.id}  ${mut.name}\n         目标文件缺失：${mut.file}`);
      continue;
    }
    const before = fs.readFileSync(target, 'utf8');
    const after = mut.replaceAll ? before.split(mut.from).join(mut.to) : before.replace(mut.from, mut.to);
    changed = after !== before;
    if (changed) fs.writeFileSync(target, after, 'utf8');
  } else if (Array.isArray(mut.createFiles) && mut.createFiles.length > 0) {
    changed = true;
  }

  if (!changed) {
    broken++;
    // 措辞要能区分两种成因：「文本没命中」和「命中了但替换是 no-op（from === to）」。
    // 旧措辞一律说"未找到目标文本"，会把 no-op 误报成"文本不存在"，反过来误导排查方向。
    report(
      `  BROKEN ${mut.id}  ${mut.name}\n` +
      `         变异未生效：目标文本未命中，或替换后内容与原文完全相同（no-op）` +
      ` —— from=${JSON.stringify(mut.from)}`
    );
    continue;
  }

  stage('运行沙箱回归…');
  const { code, out, timedOut, timeoutMs } = runRegression(sandbox);
  const spent = ((Date.now() - t0) / 1000).toFixed(1);

  if (timedOut) {
    broken++;
    report(
      `  BROKEN ${mut.id}  ${mut.name}\n` +
      `         沙箱回归运行超时（>${timeoutMs}ms）后被杀，判据不可信；` +
      `多半是沙箱缺少测试网 require() 的资源（如 node_modules）导致子进程挂死`
    );
    continue;
  }

  const caught = code !== 0;

  if (caught && hasAssertionFailure(out)) {
    report(`  PASS   ${mut.id}  ${mut.name}  (${spent}s)\n         被捕获 → ${firstFailingAssertion(out)}`);
  } else if (caught) {
    // 仅仅"退出码非 0"不算守住：脚本崩溃（语法错误 / 缺文件）也会非 0，
    // 那是判据失效，不是测试网真的守住了这条约束。
    broken++;
    report(
      `  BROKEN ${mut.id}  ${mut.name}  (${spent}s)\n` +
      `         测试网以「崩溃」而非「断言失败」变红，判据不可信：${firstFailingAssertion(out)}`
    );
  } else if (!ranForReal(out)) {
    // 退出码 0 且没有有效汇总行 ⇒ 这一轮**根本没跑完**（静默退出）。
    // 这既不是"守住了"也不是"有盲区"—— 是判据本身失效，必须判 BROKEN 而不是 FAIL。
    broken++;
    report(
      `  BROKEN ${mut.id}  ${mut.name}  (${spent}s)\n` +
      `         沙箱回归静默退出：退出码 0 但没有汇总行（输出 ${String(out).length} 字符）——` +
      `这一轮根本没跑完，不能据此认为"被捕获/有盲区"`
    );
  } else {
    broken++;
    report(`  FAIL   ${mut.id}  ${mut.name}  (${spent}s)\n         测试网未捕获该回归（测试网存在盲区，需补断言）`);
  }
}

// 清理临时副本（本轮沙箱根目录 + 历史遗留的仓库内沙箱）
fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true });
fs.rmSync(path.join(ROOT, 'analysis', '_mutation_tmp'), { recursive: true, force: true });

// 自检：确认清理后原仓库仍全绿
const base = runRegression(ROOT);
const baseSum = summarize(base.out);
// 【2026-09-26】同样不能只看退出码：零输出的静默退出也是 0。
const baseGreen = base.code === 0 && ranForReal(base.out);

console.log('变异验证报告 (Mutation Check)');
console.log('='.repeat(64));
console.log(results.join('\n'));
console.log('='.repeat(64));
console.log(`变异共 ${MUTATIONS.length} 项：被测试网捕获 ${MUTATIONS.length - broken} 项，漏网 ${broken} 项`);
console.log(
  `原仓库基线回归测试：${baseGreen ? '全绿' : '异常'}` +
  ` (exit=${base.code}, 汇总行=${baseSum.ran ? '有' : '无'}, 通过=${baseSum.passed} 项, 失败=${baseSum.failed} 项)`
);

if (broken > 0 || !baseGreen) {
  console.error('\n变异验证未通过：测试网存在盲区、有 BROKEN 项，或原仓库基线不绿/未真正跑完。');
  process.exit(1);
}

console.log('\n变异验证通过：所有历史缺陷模式重种后均被测试网捕获。');
