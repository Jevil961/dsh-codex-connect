# Codex Connect：Alpha 设计

## 所有权与组合

本包通过 Harness 公共 `LlmRuntime` 与 `PiAiAdapter` 注册 `openai-codex`。主模型路径不是一次性 subagent，而是标准 Harness agent loop，因此原生工具审批、权限策略、流式输出、附件解析、reasoning replay、会话持久化、压缩与恢复均保持有效。

bundle patch 只插入 `llm-openai-codex`，不会写入 `agent-default-model` 或 `web.searchProvider`。`enableSearch`、`enableImageTool` 与 `autoWaitForQuota` 默认均为 `false`；关闭时不会注册对应可选服务。`autoWaitForQuota` 只在选中账号的 5 小时窗口返回未来 `resetAt` 时等待并重试同一个失败步骤；周额度为零、缺少重置时间或额度查询失败时停止/交给正常恢复，不会轮换凭据或购买额度。

## `/persist` 工作流

Codex Connect 通过 DSH 原生 `dsh-commands` 注册 `/persist`，不另建 Composer。目标、计划、问题、批准的补充项、额度等待和完成状态以 `persist/change` whole-value 事件写入 Session；恢复时从事件日志重新折叠。初始目标只触发只读规划回合，只有用户明确 `/persist confirm` 后才创建 `dsh-goal` 持久目标。目标回合由 Harness 的 Goal round driver 续跑，默认上限为 256 回合。

规划提示要求覆盖痛点、范围、验收、测试、UI/UX、可访问性、性能、部署与回滚，并使用结构化 marker 让插件识别“需要回答问题”或“等待确认”。执行中发现的范围外创意必须以 addendum marker 暂停目标，等待再次确认；普通 Harness 工具与审批策略不被绕过。Codex 5 小时等待仅在已确认的 `/persist` 任务活动时自动启用，周额度耗尽只记录为可恢复状态，账号切换仍需用户显式选择。

Host 将 `llm-openai-codex` 注册为插件自有的能力 settings namespace。DSH 的 `llm-pi-ai` catalog 持有 `openai-codex` 可配置 provider 目录条目，Codex Connect 只注册实际 adapter，不重复声明该条目。浏览器通过 Harness settings-scope transport 绑定插件 namespace，把账户、额度以及带保存/放弃的能力配置放在现有“插件配置”卡片中。带 revision 防护的逐字段写入不会覆盖无关设置；提交后会即时协调搜索与图片能力的注册状态，且绝不写入默认模型或全局搜索 namespace。

profile 默认使用有限的 SSE。长驻 NAS 主机可以显式选择 `websocket`、`websocket-cached` 或 `auto`：前者复用连接但不复用缓存续接，中间项同时复用按 Session 的连接和续接上下文，后者允许固定版本的 pi-ai 在 WebSocket 建立或使用失败时回退到 SSE。传输方式随 profile snapshot 捕获，因此设置修改只作用于下一次请求，不会改变进行中的操作。

## OAuth 持久化

插件使用 `$DSH_HOME/.openai-codex-auth.json`，与 Codex CLI/Desktop 状态分离。文件格式严格且有版本号；POSIX 上会拒绝组/其他用户可读文件。父目录和文件按仅所有者权限创建，写入采用原子替换，刷新修改使用 Harness 跨进程文件锁，返回给调用方的是凭据副本。浏览器 origin 授权单独存放于 `$DSH_HOME/.openai-codex-trusted-origins.json`，格式为 `version: 1`、`mode: "allowlist"` 和规范化的精确 HTTP(S) origin；其中不含 OAuth 内容，且只能通过独立 CLI 修改。

为兼容迁移，设置页路由、OAuth 路径和 provider id 不改名。浏览器请求默认只允许 loopback；远程请求必须使用当前 sidecar 中的精确有效 HTTP(S) origin，不能带 cross-site Fetch Metadata，若带 Origin 还必须精确匹配。每次请求都会重新读取 sidecar；未知字段或错误 mode 会快速失败。登录挑战只接受不含凭据的 HTTPS 地址；30 秒内未得到地址、provider 已结束但没有地址、退出登录或插件卸载时，所有 waiter 都会被清理。只有显式登录会输出授权 URL 或代码；状态输出会脱敏。doctor 只用 `lstat` 检查元数据，不打开文件。

## 搜索与图片

仅当 `enableSearch: true` 时注册 Codex 独立搜索提供方和不含凭据的请求事件。多 provider 环境仍需显式设置 `web.searchProvider: openai-codex`。仅当 `enableImageTool: true` 且 tools、filesystem、attachments 服务存在时注册 `view_image`。本地文件继续受 Harness 文件系统边界与大小限制；远程图片只允许不含凭据的公共 HTTP(S)，所有 DNS 结果必须是公共单播地址，每次重定向都会重新验证，并把实际连接固定到已验证地址以关闭 DNS rebinding 缺口。

## 冲突、诊断与兼容边界

注册前检查现有 provider id；发现 `openai-codex` 已被占用时，给出旧 bundle 或手动 provider 配置的定向迁移提示。boot-free CLI doctor 只报告包/运行时版本、OAuth 路径元数据、能力默认值和安全提示。

Alpha 固定使用 Harness `0.1.1-rc.2` 开发依赖，并采用其 keyed `settings.plugin.item` 契约；Node.js 支持 `^22.19.0 || >=24.0.0`。`@earendil-works/pi-ai` 固定为 `0.82.1`。资格、额度、模型和后端协议仍由上游控制。测试仅使用临时 OAuth 文档和模拟网络响应，CI 不执行真实认证。
