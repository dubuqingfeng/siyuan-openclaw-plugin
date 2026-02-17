# OpenClaw 思源笔记插件（SiYuan）

这是一个 OpenClaw Gateway 插件，用于把思源笔记（SiYuan）接入到网关：在模型回复前自动“回忆/检索”相关笔记，并在对话结束后把内容按规则写入思源。

## 功能

- 记忆回忆（Memory Recall）
  - 意图识别与关键词提取
  - 多通路检索：思源全文 / 思源 SQL / 本地 FTS（SQLite FTS5）
  - 两阶段：先广召回，再重排 + 文档多样性控制
  - 结果按 token 预算格式化为 `<siyuan_context>...</siyuan_context>`
- 智能路由（Routing）
  - 显式指令、规则匹配、上下文关联、收件箱兜底
- 对话写入（Write）
  - 多种捕获策略（smart / last_turn / full_session）
  - 过滤寒暄与过短内容、模板化落盘、去重
- 本地索引（Index）
  - 自动初次同步 + 后台增量同步
  - SQLite FTS5 加速离线检索

## 安装

```bash
pnpm install
```

## 配置

配置加载优先级：

1) OpenClaw Gateway 配置（推荐）：网关传入 `api.config.siyuan` 时直接使用
2) 配置文件：`~/.openclaw/siyuan.config.json`
3) 环境变量覆盖：
   - `SIYUAN_API_URL`
   - `SIYUAN_API_TOKEN`

示例（`~/.openclaw/siyuan.config.json`）：

```json
{
  "siyuan": {
    "apiUrl": "http://127.0.0.1:6806",
    "apiToken": "your-api-token"
  },
  "routing": {
    "rules": []
  }
}
```

## 记忆回忆机制（推荐理解方式）

实现位于 `src/services/memory-recall.js`，整体是“多通路检索 + 两阶段召回 + 上下文拼装”。

### 为什么更推荐“按文档索引优先”

思源底层是 block 模型，但在“给 LLM 做检索回忆”时，**只按块（block）做一等检索单位**通常会更吵（块太碎、语义不完整、容易命中标题/元信息）。

本插件采用的折中是：

- 召回/排序更偏向“文档维度”（把同一篇文档的块内容聚合成 `doc.content` 进入本地 FTS，提升命中主题的概率）
- 上下文拼装仍然输出“块片段”（从候选文档中挑选相关块作为可核对引用）

本地索引同步时会为每篇文档生成：

- `doc.content`：由该文档的块内容拼接而成（用于文档级召回）
- `doc.blocks`：保留部分块用于片段引用（用于上下文拼装）

你可以通过配置覆盖每篇文档拼接/保留的块数量（可选）：

本插件本地索引默认使用“整篇文档的 kramdown 源码”作为单一来源（需要思源 HTTP API 支持 `/api/block/getBlockKramdown`），这样通常比拼接 blocks 更稳定（尤其是有序列表 1.2.3.）。

你也可以按标题层级把一篇文档切成“小节”来做本地索引（更推荐，用于提升相关性，默认按 H2）：

```json
{
  "index": {
    "sectionHeadingLevels": [2],
    "maxSectionsToIndex": 80,
    "sectionMaxChars": 1200
  }
}
```

## 设计文档

- `DESIGN.md`：生命周期、架构与关键流程图
