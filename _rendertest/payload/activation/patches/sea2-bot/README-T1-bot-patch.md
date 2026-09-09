# T1 部署补丁说明（sea2-bot 端 + config.env）

> 本目录为 **sea2-bot**（生产路径 `/root/sea2/plugins/vip/`）的补丁文件。
> sea2-bot 源码不在本地仓库（T1 只改 sea2-server 本地 + 提供 bot 端补丁），
> 部署时由主理人将下列文件/片段应用到生产服务器。**禁止通过本补丁直接修改生产文件**，仅供部署参考。

---

## 1. P0-1：自动发码端点端口冲突（13007 → 13008）

### 背景（排查实锤）
- sea1-bot（`/root/sea1/sea.js`）与 sea2-bot（`/root/sea2/sea.js`）的
  `plugins/vip/botNotifyServer.js` 默认端口都是 **13007**，sea1-bot 先启动占用。
- sea2-bot error 日志反复出现：
  `[botNotify] 自动发码端点启动失败（已忽略，降级为无全自动）: listen EADDRINUSE: address already in use 127.0.0.1:13007`
- 结果：sea2 侧「webhook 到账 → 自动发码」全自动链路从未生效。

### 改动（2 处）
1. **sea2-bot**：把本目录 `botNotifyServer.js` 复制覆盖到生产
   `/root/sea2/plugins/vip/botNotifyServer.js`（默认端口已改为 13008，且新增
   `event:'activated'` 处理，见第 3 节）。
   - 等价替代：不改文件，给 sea2-bot 进程设置 `BOT_NOTIFY_PORT=13008` 环境变量后重启。
2. **sea1-activation-server**（服务端）：`/root/sea1-activation-server/config.env` 中
   `BOT_NOTIFY_URL` 改为：
   ```
   BOT_NOTIFY_URL="http://127.0.0.1:13008/vip/notify-paid"
   ```
   改后需重启服务端进程生效（`pm2 restart sea1-activation`——由主理人执行，本补丁不代做）。
   ⚠️ 注意：`BOT_NOTIFY_TOKEN` 必须保持与 sea2-bot 进程 env / `config.json.license.botNotifyToken` 一致。

---

## 2. P1-7：激活成功群通知（bot 端推送）

### 背景
- 服务端无 QQ 群通道；激活成功群通知由 bot 端完成。
- 服务端改动（已并入 sea2-server 本地代码）：`/api/order/issue` 签发成功后会向
  `BOT_NOTIFY_URL` 投递 `{order_id, event:'activated', qq, plan}`；
  未配置 `BOT_NOTIFY_URL` 时为 no-op，不影响签发。
- 本目录 `botNotifyServer.js` 已支持识别 `event:'activated'` → 回调 `onActivated`。

### 需在 bot 端 vip/index.js 补充 onActivated 推送（在 startBotNotifyServer 调用处）

定位：`/root/sea2/plugins/vip/index.js` 中 `startBotNotifyServer({...})` 调用块
（现有代码约在 96-119 行，含 `onIssue: (lic) => { ... }`）。

在 `onIssue` 同级新增 `onActivated` 回调（并在文件顶部已有 `sendPrivateMsg` 处
确认 `this._cfg.notify_groups` 与 `global.sea1.adapter` 可用）：

```js
// 在 startBotNotifyServer({ ... }) 参数里，onIssue 同级追加：
onActivated: ({ orderId, qq, plan }) => {
  try {
    const groups = (this._cfg && this._cfg.notify_groups) || [];
    const text = [
      '🎉 开通永久会员成功！',
      '订单：' + String(orderId || ''),
      (qq ? '客户 QQ：' + qq : ''),
      (plan ? '套餐：' + plan : ''),
      '系统已自动激活并下发许可证。',
    ].filter(Boolean).join('\n');
    const adapter = global.sea1 && global.sea1.adapter;
    if (!adapter || typeof adapter.send !== 'function') {
      console.warn('[VIP] 激活成功群通知失败：QQ 适配器未就绪');
      return;
    }
    for (const g of groups) {
      adapter.send(String(g), text, { groupId: String(g) }).catch((e) => {
        console.warn('[VIP] 激活成功群通知发送失败 group=' + g + ':',
          (e && e.message) || e);
      });
    }
  } catch (e) {
    console.warn('[VIP] 激活成功群通知构造失败（已忽略）:', (e && e.message) || e);
  }
},
```

> 说明：`adapter.send(id, text, opts)` 的第三个参数 `{ groupId }` 与
> `sea.js` 试用提醒的用法一致（`qqAdapter.send(id, text, o)`），请以实际适配器签名为准。

---

## 3. 部署清单（主理人执行）

| 步骤 | 文件 | 动作 |
|---|---|---|
| 1 | `/root/sea2/plugins/vip/botNotifyServer.js` | 用本目录同名文件覆盖（端口 13008 + event 处理） |
| 2 | `/root/sea2/plugins/vip/index.js` | 按第 2 节片段追加 `onActivated` 回调 |
| 3 | `/root/sea1-activation-server/config.env` | `BOT_NOTIFY_URL` → `http://127.0.0.1:13008/vip/notify-paid` |
| 4 | 进程 | `pm2 restart sea2-bot && pm2 restart sea1-activation`（主理人执行） |
| 5 | 验证 | `ss -tlnp | grep 13008` 应看到 sea2-bot 监听；`curl -s http://127.0.0.1:13008/vip/notify-paid` 应返回 404（未带 token/事件时不执行发码） |

## 4. 其他说明
- 若 sea2-bot 实际通过 `BOT_NOTIFY_PORT` 环境变量启动（可覆盖默认端口），
  步骤 1/3 可等价改为统一设置 `BOT_NOTIFY_PORT=13008` 并同步 config.env。
- `BOT_NOTIFY_TOKEN` 两端的共享令牌必须一致，否则回调被 401 拒绝（fail-closed 属正常行为）。
