# dsh-session-attention

[English](README.en.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的会话消息通知覆盖层插件。

一个角色从 Web GUI 的右上角探出，在任意会话等待用户操作（审批 / 计划待审 / 提问）或后台会话的 AI 回复完成未查看时，播放与提醒类型对应的舞蹈动画。所有会话处理完毕后角色缩回。

![会话提醒覆盖层：右上角的角色面板显示一条「回复完成」关注行](docs/attention.png)

## 架构

两个包组成完整功能：

| 包 | 名称 | 角色 |
|---|---|---|
| `client/` | `@deepseek-ai/dsh-client-ui-session-attention` | 双面插件：浏览器半部渲染 `shell.overlay` 角色动画并通过 Typert Remote 调用 host 半部；host 半部是 `sessionAttentionToast` 服务，把通知渲染成原生 Win11 Toast |
| `bundle/` | `@deepseek-ai/dsh-session-attention` | Profile bundle：一个 `cordis.patch.yml` 插入客户端面板行 |

该插件由**浏览器半部 + 一个 host 半部服务**组成：浏览器半部从 web 界面已提供的标准 `useSessions` 和 `useSessionPendingInteraction` 数据流派生关注行，既渲染右上角角色动画，也会话进入关注态时通过 Typert 网关调用 host 半部的 `sessionAttentionToast` 服务，由后者驱动 Windows PowerShell 弹出原生 Toast（WSL 环境下走 `/mnt/c/Windows/.../powershell.exe` 互操作）。

### 数据流

```
会话状态 → useSessions hook（完成提醒）
           useSessionPendingInteraction hook（审批/计划待审/提问）
                               ↓
               selectAttention(list, pending) — 纯派生（动画与 Toast 共用同一份）
                               ↓
               AttentionPanel（shell.overlay 入口）
               ├── 角色动画（Canvas2D）
               ├── 关注行（点击打开会话）
               ├── 浏览器标签页标题前缀 (N)
               └── ToastBridge（shell.overlay 入口）
                       ↓ 会话进入关注态时
               sessionAttentionToast 服务（host 半部，Typert Remote）
                       ↓
               Windows PowerShell → 原生 Win11 Toast
```

### 角色动画

角色生命周期是四阶段状态机：`peek → enter → dance → exit → peek`。四种舞蹈对应四种提醒类型：

- **approval（审批）** — 焦急的小跳加身体抖动
- **plan-review（计划待审）** — 思考的摇摆加歪头，思考窗口期间头顶出现 ✨
- **question（提问）** — 困惑的左右歪头加 `?` 气泡
- **completed（完成）** — 庆祝的弹跳、摇摆、旋转加 ✨

动画引擎从流逝时间和生命周期阶段纯函数地计算每帧的 `translate / rotate / scale / squash` 变换——确定性（无 `Math.random`）且可在 jsdom 中完整测试。角色可以是用户提供的 PNG（通过 `characterImage` 配置）或程序绘制的默认角色。

## 安装

面板仅在 web 界面中渲染，因此目标 profile 必须是一个 **web surface profile**（已提供 client 运行时、连接和 `shell.overlay` 布局）。`dsh web` 使用的默认 profile 名是 `web`。需要 `pnpm` 在 `PATH` 上。

```sh
# 用一个已存在的 web surface profile 名替换 <name>（缺省 web surface profile 就叫 `web`）
dsh plugin --profile web add https://github.com/my-dsh/dsh-session-attention/releases/download/dist/dsh-session-attention-dist.tgz
```

包声明了 `dsh.bundle`，安装后自动加入 profile 的 bundle 层栈；**重启 DSH** 后生效。

### 自定义角色图片

```yaml
- id: ui-session-attention
  name: '@deepseek-ai/dsh-client-ui-session-attention'
  config:
    characterImage: 'data:image/png;base64,...'
```

不设置时使用程序绘制的默认角色。

## 用法

覆盖层无需配置：在下次启动时开始运行，监听标准会话数据流。角色从右上角探出，在需要关注时跳出舞蹈，并显示等待操作的会话行。点击一行可打开该会话并消除提醒。有待办时浏览器标签页标题加 `(N)` 前缀，使提醒在标签页切到后台时仍可见。

## 源码布局

```
dsh-session-attention/
├── client/
│   ├── src/
│   │   ├── index.ts               # Host 半部：sessionAttentionToast 服务（Win11 Toast 桥）
│   │   ├── invariant.ts           # 包不变量伴随
│   │   ├── css-modules.d.ts       # CSS Modules 类型声明
│   │   ├── types.ts               # Toast 请求/响应线协议（host 与 client 共用）
│   │   └── client/
│   │       ├── index.ts           # 浏览器插件：shell.overlay 注册 + 挂载 Toast Remote 命名空间
│   │       ├── attention.ts       # 纯关注行选择逻辑
│   │       ├── AttentionPanel.tsx # 面板组件（行 + 画布）
│   │       ├── toast-bridge.tsx   # Toast 桥：派生同一份关注行，会话进入关注态时触发 Toast
│   │       ├── typert.ts          # 手写 Consumer Remote 描述（sessionAttentionToast/send）
│   │       ├── character.ts       # Canvas2D 动画引擎
│   │       ├── character-lifecycle.ts  # peek→enter→dance→exit 状态机
│   │       ├── contract/
│   │       │   └── slots.ts       # Inject face 契约
│   │       └── ...
│   └── package.json
├── bundle/
│   ├── cordis.patch.yml           # 1 行插入：客户端面板
│   ├── src/
│   │   ├── index.ts               # 空壳 carrier
│   │   └── invariant.ts           # Bundle 不变量伴随
│   └── package.json
└── package.json                   # 根 workspace
```

## 依赖

该插件依赖以下 DSH 包（从 DSH monorepo 安装）：

- `@deepseek-ai/cordis` — Cordis 插件框架
- `@deepseek-ai/dsh-client-ui-layout` — `shell.overlay` slot 声明者
- `@deepseek-ai/dsh-client-ui-renderer` — Slot registry 服务
- `@deepseek-ai/dsh-client-ui-session` — `useSessions` 和 `useSessionPendingInteraction` hook
- `@deepseek-ai/dsh-api-session-controller` — `SessionListState`、`SessionSummary`、`PendingInteractionStatus`
- `@deepseek-ai/dsh-session` — `SessionId` 品牌类型

## 许可证

MIT
