# Alma Plugin Spec: OpenAI Codex Native

## 概述

创建一个新的 Alma 插件 `openai-codex-native`，通过本地 `codex` CLI 的 app-server（stdio 模式）来访问 OpenAI 模型，绕过 Cloudflare 拦截问题。

## 背景

- 现有插件 `openai-codex-auth` 直接 fetch `chatgpt.com/backend-api/codex/responses`，被 Cloudflare 403 拦截
- `codex` CLI（OpenAI 官方工具）内部处理了 CF 验证，能正常访问
- OpenClaw 项目的做法：spawn `codex app-server --listen stdio://`，通过 JSON-RPC over stdio 通信
- 我们需要在 Alma 插件里复制这个模式

## 环境信息

- Codex CLI: `/opt/homebrew/bin/codex` v0.120.0
- Codex 已通过 ChatGPT Pro 账号登录（OAuth tokens 在 `~/.codex/auth.json`）
- 可用模型缓存在 `~/.codex/models_cache.json`
- Alma 插件目录: `~/.config/alma/plugins/`
- 现有插件: `~/.config/alma/plugins/openai-codex-auth/`
- 新插件: `~/.config/alma/plugins/openai-codex-native/`

## Alma 插件结构

### manifest.json
```json
{
    "id": "openai-codex-native",
    "name": "OpenAI Codex Native",
    "version": "1.0.0",
    "description": "Use ChatGPT Plus/Pro subscription with Alma via local Codex CLI app-server. Bypasses Cloudflare by delegating requests to the codex binary.",
    "author": {
        "name": "Alma Community"
    },
    "main": "main.js",
    "engines": {
        "alma": "^0.1.0"
    },
    "type": "provider",
    "permissions": [
        "network:fetch",
        "network:localhost",
        "providers:manage",
        "notifications"
    ],
    "activationEvents": [
        "onStartup"
    ],
    "contributes": {
        "providers": [
            {
                "id": "openai-codex-native",
                "name": "OpenAI Codex (Native)",
                "authType": "none"
            }
        ]
    },
    "keywords": [
        "openai",
        "codex",
        "chatgpt",
        "gpt-5",
        "native"
    ]
}
```

注意：manifest 里 `main` 写的是 `main.js`，但实际只有 `main.ts` 文件。Alma 会自动处理 TypeScript 编译。所以我们写 `main.ts` 即可。

### Plugin API（从现有插件反推）

Alma 插件导出一个 `activate(context)` 函数，context 提供：
- `context.logger` - 日志 (info/warn/error/debug)
- `context.storage.secrets` - 安全存储
- `context.providers` - 注册 provider
- `context.commands` - 注册命令
- `context.ui` - UI 通知/对话框

Provider 需要实现的接口：
```typescript
interface Provider {
    id: string;
    name: string;
    description: string;
    authType: 'oauth' | 'none';

    initialize(): Promise<void>;
    isAuthenticated(): Promise<boolean>;
    getModels(): Promise<Model[]>;
    fetchModels(): Promise<Model[]>;

    // 关键！返回给 AI SDK 的配置
    getSDKConfig(): Promise<{
        apiKey: string;
        baseURL: string;
        fetch: typeof globalThis.fetch;
        useResponsesAPI?: boolean;
    }>;
}
```

Model 格式：
```typescript
interface Model {
    id: string;           // e.g. "gpt-5-high"
    name: string;         // e.g. "GPT-5 (High Reasoning)"
    description?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    capabilities: {
        streaming: boolean;
        reasoning: boolean;
        functionCalling: boolean;
        vision?: boolean;
    };
    providerOptions?: Record<string, any>;
}
```

## Codex App-Server 协议（JSON-RPC over stdio）

### 传输层
- 启动命令: `codex app-server --listen stdio://`
- 通信方式: JSON-RPC，每条消息一行（newline-delimited JSON）
- stdin: 发送请求
- stdout: 接收响应和通知
- stderr: 日志（可忽略）

### RPC 消息格式

请求:
```json
{"id": 1, "method": "initialize", "params": {...}}
```

响应:
```json
{"id": 1, "result": {...}}
```

错误:
```json
{"id": 1, "error": {"code": -1, "message": "error text"}}
```

通知（服务器主动推送，无 id）:
```json
{"method": "item/agentMessage/delta", "params": {...}}
```

服务器请求（有 id 和 method，需要客户端回复）:
```json
{"id": 100, "method": "item/commandExecution/requestApproval", "params": {...}}
```

### 初始化握手

1. 客户端发送 `initialize` 请求：
```json
{
    "id": 1,
    "method": "initialize",
    "params": {
        "clientInfo": {
            "name": "alma",
            "title": "Alma",
            "version": "1.0.0"
        },
        "capabilities": {
            "experimentalApi": true
        }
    }
}
```

2. 服务器返回版本信息：
```json
{
    "id": 1,
    "result": {
        "userAgent": "codex/0.120.0 ...",
        "codexHome": "/Users/ken/.codex",
        "platformFamily": "mac",
        "platformOs": "macos"
    }
}
```

3. 客户端发送 `initialized` 通知：
```json
{"method": "initialized"}
```

### 获取模型列表

请求 `model/list`：
```json
{
    "id": 2,
    "method": "model/list",
    "params": {
        "limit": null,
        "cursor": null,
        "includeHidden": null
    }
}
```

响应：
```json
{
    "id": 2,
    "result": {
        "data": [
            {
                "model": "gpt-5",
                "slug": "gpt-5",
                "displayName": "gpt-5",
                "description": "...",
                "inputModalities": ["text", "image"],
                "supportedReasoningEfforts": [
                    {"reasoningEffort": "minimal"},
                    {"reasoningEffort": "low"},
                    {"reasoningEffort": "medium"},
                    {"reasoningEffort": "high"}
                ],
                "defaultReasoningEffort": "medium"
            }
        ]
    }
}
```

### 创建线程 + 发送消息（核心对话流程）

#### 1. 启动线程 `thread/start`
```json
{
    "id": 3,
    "method": "thread/start",
    "params": {
        "model": "gpt-5",
        "modelProvider": "openai",
        "cwd": "/tmp",
        "approvalPolicy": "never",
        "sandbox": "read-only",
        "serviceName": "Alma",
        "developerInstructions": "You are a helpful assistant.",
        "dynamicTools": null,
        "experimentalRawEvents": true,
        "persistExtendedHistory": true
    }
}
```

响应：
```json
{
    "id": 3,
    "result": {
        "thread": {"id": "thread_xxx"},
        "model": "gpt-5",
        "modelProvider": "openai"
    }
}
```

#### 2. 发送消息 `turn/start`
```json
{
    "id": 4,
    "method": "turn/start",
    "params": {
        "threadId": "thread_xxx",
        "input": [
            {"type": "text", "text": "Hello!"}
        ],
        "cwd": "/tmp",
        "approvalPolicy": "never",
        "model": "gpt-5",
        "effort": "medium"
    }
}
```

响应（返回 turn id）：
```json
{
    "id": 4,
    "result": {
        "turn": {"id": "turn_xxx"}
    }
}
```

#### 3. 接收流式输出（通知）
服务器通过通知推送内容：
```json
{"method": "item/agentMessage/delta", "params": {"threadId": "thread_xxx", "turnId": "turn_xxx", "itemId": "item_xxx", "delta": "Hello"}}
{"method": "item/agentMessage/delta", "params": {"threadId": "thread_xxx", "turnId": "turn_xxx", "itemId": "item_xxx", "delta": " there!"}}
{"method": "turn/completed", "params": {"threadId": "thread_xxx", "turnId": "turn_xxx", "usage": {"inputTokens": 10, "outputTokens": 20}}}
```

#### 4. 处理服务器请求（审批等）
服务器可能请求审批（工具调用、文件修改等），需要回复：
```json
// 服务器请求：
{"id": 100, "method": "item/commandExecution/requestApproval", "params": {...}}

// 客户端回复（拒绝所有审批）：
{"id": 100, "result": {"decision": "decline"}}
```

默认回复策略（匹配 OpenClaw）：
- `item/tool/call` → `{"contentItems": [{"type": "inputText", "text": "Not handled"}], "success": false}`
- `item/commandExecution/requestApproval` → `{"decision": "decline"}`
- `item/fileChange/requestApproval` → `{"decision": "decline"}`
- `item/permissions/requestApproval` → `{"permissions": {}, "scope": "turn"}`
- 其他 `requestApproval` → `{"decision": "decline"}`
- `item/tool/requestUserInput` → `{"answers": {}}`
- `mcpServer/elicitation/request` → `{"action": "decline"}`

## 核心实现思路

### 方案：代理模式（Proxy）

因为 Alma 的 Provider 需要返回 `getSDKConfig()` 包含 `{ apiKey, baseURL, fetch }`，AI SDK 会用这个 fetch 发 OpenAI 格式的请求。

**关键思路**：在插件里启动一个本地 HTTP 代理服务器（或者直接在 custom fetch 里转发）：

1. AI SDK 调用 `fetch(baseURL + "/responses", { body: ... })`
2. 我们的 custom fetch 拦截这个请求
3. 解析请求体，提取 model、messages/input、tools 等
4. 通过 codex app-server stdio 转发：
   - 如果还没创建 thread → `thread/start`
   - 发送 `turn/start` 带用户 input
   - 收集 `item/agentMessage/delta` 通知
   - 等待 `turn/completed`
5. 将收集到的内容重新组装成 OpenAI Responses API 格式的 SSE 流返回

### 难点和注意事项

1. **Alma 插件能不能用 `child_process`？**
   - manifest 里的 `main` 是 `main.js`，但实际只有 `main.ts`
   - Alma 似乎会在 Node.js 环境里运行插件
   - 需要验证 `require('node:child_process')` 或 `import { spawn } from 'node:child_process'` 是否可用
   - 如果不行，备选方案：用 WebSocket transport（`codex app-server --listen ws://127.0.0.1:PORT`）

2. **SSE 流转换**
   - codex app-server 返回的是 JSON-RPC 通知（逐行 JSON）
   - AI SDK 期望的是 OpenAI SSE 格式（`data: {...}\n\n`）
   - 需要把 `item/agentMessage/delta` 通知转换成 OpenAI 的 `response.output_item.delta` 事件

3. **线程管理**
   - 每次对话可能需要新的 thread，或者复用已有 thread
   - 简单起见，可以每次请求创建新 thread（stateless 模式）
   - 或者维护 thread pool 做会话持久化

4. **Tool calling（function calling）**
   - AI SDK 会在请求里带上 tools 定义
   - 需要通过 `dynamicTools` 传给 codex app-server
   - 或者直接通过 `thread/start` 的参数传递
   - codex 回的 tool call 需要转换成 AI SDK 格式

5. **Reasoning（思考）**
   - codex 支持 reasoning effort：minimal/low/medium/high/xhigh
   - 需要从模型名（如 `gpt-5-high`）解析出 effort 级别
   - 通过 `turn/start` 的 `effort` 参数传递

## 文件结构

```
~/.config/alma/plugins/openai-codex-native/
├── manifest.json          # 插件清单
├── main.ts                # 主入口（Alma 自动编译 TS）
└── README.md              # 说明文档
```

## 模型映射

从 `~/.codex/models_cache.json` 读取，生成 Alma 模型列表：

| Codex Slug | 支持的 Reasoning Levels | 默认 Level |
|---|---|---|
| gpt-5.4 | low, medium, high, xhigh | medium |
| gpt-5.4-mini | low, medium, high, xhigh | medium |
| gpt-5.3-codex | low, medium, high, xhigh | medium |
| gpt-5.3-codex-spark | low, medium, high, xhigh | high |
| gpt-5.2-codex | low, medium, high, xhigh | medium |
| gpt-5.2 | low, medium, high, xhigh | medium |
| gpt-5.1-codex-max | low, medium, high, xhigh | medium |
| gpt-5.1-codex | low, medium, high | medium |
| gpt-5.1 | low, medium, high | medium |
| gpt-5-codex | low, medium, high | medium |
| gpt-5 | minimal, low, medium, high | medium |
| gpt-5.1-codex-mini | medium, high | medium |
| gpt-5-codex-mini | medium, high | medium |

每个 slug + reasoning level 组合生成一个 Alma 模型 ID，例如：
- `gpt-5` (默认 medium)
- `gpt-5-high` (high reasoning)
- `gpt-5-low` (low reasoning)

## SSE 响应格式转换

AI SDK 期望的 OpenAI Responses API SSE 格式：

```
data: {"type":"response.created","response":{"id":"resp_xxx","object":"response","model":"gpt-5","output":[],"status":"in_progress"}}

data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_xxx","role":"assistant","content":[],"status":"in_progress"}}

data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}

data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hello"}

data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":" there!"}

data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"Hello there!"}

data: {"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello there!"}}

data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_xxx","role":"assistant","content":[{"type":"output_text","text":"Hello there!"}],"status":"completed"}}

data: {"type":"response.completed","response":{"id":"resp_xxx","object":"response","model":"gpt-5","output":[...],"status":"completed","usage":{"input_tokens":10,"output_tokens":20}}}

data: [DONE]
```

对应 codex app-server 的通知：
- `item/agentMessage/delta` → `response.output_text.delta`
- `item/agentMessage/completed` → `response.output_item.done`
- `turn/completed` → `response.completed`

## 备选方案：WebSocket 模式

如果 Alma 插件不允许 `child_process.spawn`，可以改用 WebSocket：

1. 在插件外（比如 launchd）启动 `codex app-server --listen ws://127.0.0.1:19856`
2. 插件通过 WebSocket 连接 `ws://127.0.0.1:19856`
3. 同样的 JSON-RPC 协议，只是传输层不同

这样不需要 spawn 权限，只需要 `network:localhost` 权限（manifest 里已有）。

## 测试验证

1. **模型列表**：插件启动后在 Alma 设置里能看到模型
2. **简单对话**：选择 gpt-5 模型，发送 "hello" 能收到回复
3. **流式输出**：回复是逐字显示而不是一次性出现
4. **Tool calling**：AI SDK 的 function calling 能正常工作
5. **错误处理**：codex 进程崩溃后能自动重启

## 参考代码

- 现有 Alma 插件: `~/.config/alma/plugins/openai-codex-auth/main.ts`（710 行）
- OpenClaw codex 客户端: https://github.com/openclaw/openclaw/tree/main/extensions/codex/src/app-server/
  - `client.ts` - JSON-RPC 客户端实现（420 行）
  - `protocol.ts` - RPC 类型定义
  - `thread-lifecycle.ts` - 线程创建和 turn 参数构建
  - `run-attempt.ts` - 完整的对话执行流程
  - `event-projector.ts` - 流式事件处理
  - `models.ts` - 模型列表获取
  - `transport-stdio.ts` - stdio 传输（仅 11 行：`spawn(command, args, {stdio: ['pipe','pipe','pipe']})`)
