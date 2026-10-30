# dsh-persona-prompt

在 DeepSeek Harness 的 **设置 → 人设** 里直接编辑两段系统提示词，不用改 YAML，也不用碰预设文件。

| 字段 | 槽位 | order |
|---|---|---|
| `HARNESS_IDENTITY` | `harness:identity` | -1000 |
| `DEPLOYMENT_PERSONA_PREFIX` | `deployment:persona-prefix` | 0 |

## 功能

- 在「设置 → 人设」可视化编辑两段文本，保存即生效。
- 默认对所有主会话生效，覆盖各 Agent 预设自带的人设。
- 子代理默认保持原样；打开「同时注入子代理」后才一起改写。
- 支持 `{{model}}` 等提示词变量；留空 = 不覆盖，一键恢复原始文本。
- 状态存在 `$DSH_HOME/persona-prompt.json`，重启、换 profile 都不会丢。

## 安装

用 DSH 插件管理器安装本仓库：

```text
github:limeblogs/dsh-persona-prompt
```

本地开发时也可以直接安装目录：

```text
plugin_manager install_bundle /path/to/dsh-persona-prompt
```

安装后在 **设置 → 人设** 编辑并保存，下一次模型请求开始使用新文本。

## 用法

1. 打开 设置 → 人设。
2. 按需修改两段文本，或点「载入原始文本」。
3. 需要子代理也使用同一份文本时，打开「同时注入子代理」。
4. 点「保存并全局生效」。

留空或点「取消覆盖」表示不改写该字段；页面底部可预览保存后的 system prompt 头部。

## 作用范围

- **主会话**：所有顶层会话、所有 Agent 预设、用户 fork 出来的会话，都会改写。
- **子代理**：spawn / fork / 嵌套，默认不改写；开关打开后才改写。
- 判定看 SessionHeader：`origin: "subagent"` 或 `delegationDepth > 0`。只有 `parentSession` 的用户 fork 不算子代理。

## 数据

`$DSH_HOME/persona-prompt.json`（默认 `~/.dsh/persona-prompt.json`）：

```json
{
  "identity": "",
  "personaPrefix": "",
  "applyToSubagents": false
}
```

## 原理

`harness:identity` 的文本写死在 `dsh-system-prompt` 里，没有配置项；`deployment:persona-prefix` 又会被预设里的 `dsh-persona` 以 agent 作用域覆盖。所以本插件监听 `system-prompt/assemble` 瀑布，在全局与 agent 作用域合并之后改写最终 sections。它不改任何官方配置或预设文件，卸载即恢复。

## 冒烟测试

`test/smoke.mjs` 直接读 Host API 和真实 Session 日志：

```bash
node test/smoke.mjs state
node test/smoke.mjs save 'SMOKE-IDENTITY-MARK' 'SMOKE-PERSONA-MARK {{model}}' off
node test/smoke.mjs scan <since-ms> SMOKE-IDENTITY-MARK
node test/smoke.mjs reset
```

子代理需由调用方用 `subagent` / `subagent_fork` 真实拉起，再 `scan` 新会话核对 marker。

## 已知边界

- 预设若用 `complete: true`，官方注册表会在瀑布后覆盖整段 prompt，插件改不动。
- 多个 DSH 进程同时运行时，另一个进程需要重启才能读到新状态。

## License

MIT
