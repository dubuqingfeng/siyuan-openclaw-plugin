
好的，让我把整个流程从安装配置到运行时的每个环节都完整梳理一遍。

---
完整生命周期流程
第零阶段：安装与初始化
用户安装插件后，首次启动需要完成环境准备。
用户执行 openclaw onboard 或手动配置
        │
        ▼
┌─────────────────────────────────────┐
│  1. 检测思源笔记是否运行             │
│     GET http://127.0.0.1:6806/      │
│     api/system/version              │
│                                      │
│  2. 获取/验证 API Token             │
│     思源设置 → API Token             │
│                                      │
│  3. 扫描笔记本结构                   │
│     /api/notebook/lsNotebooks        │
│                                      │
│  4. 检查或创建基础文档结构            │
│     /OpenClaw/收件箱                 │
│     /OpenClaw/对话归档               │
│     /OpenClaw/.meta (插件元数据)     │
│                                      │
│  5. 首次全量索引构建                  │
│     遍历文档树 → 写入本地 SQLite     │
│                                      │
│  6. 写入配置到                       │
│     ~/.openclaw/openclaw.json        │
│     或 .env                          │
└─────────────────────────────────────┘
第一阶段：Gateway 启动时（register）
每次 OpenClaw Gateway 启动，插件 register 被调用。
register(api) 被调用
    │
    ├─ 1. 读取配置 buildConfig()
    │     - SIYUAN_API_URL (默认 http://127.0.0.1:6806)
    │     - SIYUAN_API_TOKEN
    │     - 路由规则、笔记本映射、索引策略等
    │
    ├─ 2. 健康检查
    │     GET /api/system/version
    │     ├─ 成功 → 标记 siyuanAvailable = true
    │     └─ 失败 → 降级模式，只缓存不写入
    │
    ├─ 3. 增量索引同步
    │     │
    │     ├─ 读取上次同步时间 last_sync_time
    │     │
    │     ├─ SQL 查询变更块
    │     │   POST /api/query/sql
    │     │   "SELECT * FROM blocks
    │     │    WHERE updated > '{last_sync_time}'
    │     │    ORDER BY updated DESC
    │     │    LIMIT 500"
    │     │
    │     ├─ 更新 doc_registry 表
    │     │   - 新文档 → INSERT
    │     │   - 已有文档 → UPDATE title/tags/updated_at
    │     │   - 已删除 → 标记 deleted
    │     │
    │     ├─ 更新 block_fts 全文索引
    │     │
    │     └─ 记录 last_sync_time = now
    │
    ├─ 4. 注册生命周期钩子
    │     ├─ before_agent_start → 召回流程
    │     ├─ agent_end → 写入流程
    │     └─ command:new → 会话重置处理
    │
    └─ 5. 启动后台定时同步（每 5 分钟）
          setInterval(incrementalSync, 5 * 60 * 1000)
第二阶段：用户发消息 → 记忆召回（before_agent_start）
用户通过任意渠道发来消息，AI 回答之前执行。
用户消息到达: "帮我回顾一下上周 Rust 项目的进展"
    │
    ▼
before_agent_start 触发
    │
    ├─ 1. 前置检查
    │     ├─ 召回功能是否开启？
    │     ├─ prompt 长度 >= 阈值？(过滤 "嗯"、"好的")
    │     ├─ 思源可用？
    │     └─ 任一不满足 → return，不注入上下文
    │
    ├─ 2. 查询意图分析（轻量规则引擎）
    │     │
    │     │  输入: "帮我回顾一下上周 Rust 项目的进展"
    │     │
    │     ├─ 提取关键词: ["Rust", "项目", "进展"]
    │     ├─ 提取时间范围: 上周 → 7天前~今天
    │     └─ 提取意图类型: 回顾/查询（非写入）
    │
    ├─ 3. 多路搜索（并行执行，合并结果）
    │     │
    │     │  ┌─ 路径A: 思源全文搜索 ──────────────┐
    │     │  │  POST /api/search/fullTextSearchBlock│
    │     │  │  { query: "Rust 项目 进展" }        │
    │     │  │  → 返回匹配的块列表                  │
    │     │  └────────────────────────────────────┘
    │     │
    │     │  ┌─ 路径B: 思源 SQL 查询 ─────────────┐
    │     │  │  POST /api/query/sql                │
    │     │  │  "SELECT * FROM blocks              │
    │     │  │   WHERE content LIKE '%Rust%'       │
    │     │  │   AND updated > '{7_days_ago}'      │
    │     │  │   ORDER BY updated DESC             │
    │     │  │   LIMIT 20"                         │
    │     │  └────────────────────────────────────┘
    │     │
    │     │  ┌─ 路径C: 本地 FTS 索引 ─────────────┐
    │     │  │  SELECT * FROM block_fts            │
    │     │  │  WHERE block_fts MATCH 'Rust 项目'  │
    │     │  │  → 快速候选，用于补充                │
    │     │  └────────────────────────────────────┘
    │     │
    │     └─ 合并去重，按相关性排序
    │
    ├─ 4. 结果聚合与格式化
    │     │
    │     ├─ 块级结果 → 按所属文档分组
    │     │
    │     │  搜索返回 15 个块，分布在 4 个文档中：
    │     │  ├─ /项目/Rust重构  (8个块命中)  → 高相关
    │     │  ├─ /日记/2026-02-07 (3个块)    → 中相关
    │     │  ├─ /日记/2026-02-05 (2个块)    → 中相关
    │     │  └─ /学习/Rust笔记   (2个块)    → 低相关
    │     │
    │     ├─ 对每个文档：获取上下文
    │     │   POST /api/block/getBlockInfo
    │     │   → 拿到文档标题、面包屑路径
    │     │
    │     ├─ 智能截断（总 token 预算控制）
    │     │   总预算 2000 tokens，按相关性分配：
    │     │   ├─ /项目/Rust重构     → 1000 tokens
    │     │   ├─ /日记/2026-02-07  → 400 tokens
    │     │   ├─ /日记/2026-02-05  → 400 tokens
    │     │   └─ /学习/Rust笔记    → 200 tokens
    │     │
    │     └─ 格式化为 prompt 块
    │
    ├─ 5. 构建 prependContext
    │     │
    │     │  <siyuan_context>
    │     │  以下是用户思源笔记中的相关内容：
    │     │
    │     │  ## 📄 /项目/Rust重构 (最近编辑: 2月7日)
    │     │  - 完成了模块A的重构，性能提升30%
    │     │  - 模块B还有3个TODO待处理
    │     │  - 和张三讨论了错误处理策略，决定用 thiserror
    │     │
    │     │  ## 📄 /日记/2026-02-07
    │     │  - Rust项目code review，发现内存泄漏问题
    │     │
    │     │  ## 📄 /日记/2026-02-05
    │     │  - 开始Rust项目模块A重构
    │     │  </siyuan_context>
    │     │
    │     └─ return { prependContext: block }
    │
    ▼
AI 拿到 [注入的笔记上下文] + [用户原始问题] 开始回答
第三阶段：AI 回答完毕 → 内容写入（agent_end）
AI 生成回答后，决定是否以及如何写入思源笔记。
AI 回答完成，agent_end 触发
    │
    ├─ 1. 前置检查
    │     ├─ 写入功能是否开启？
    │     ├─ 回答是否成功？(event.success)
    │     ├─ 思源可用？
    │     ├─ 节流检查：距上次写入 > throttleMs？
    │     └─ 任一不满足 → return
    │
    ├─ 2. 提取对话内容
    │     │
    │     ├─ 策略选择：
    │     │   ├─ last_turn: 只取最后一轮 Q&A
    │     │   ├─ full_session: 取整个会话
    │     │   └─ smart: 取有实质内容的轮次(过滤寒暄)
    │     │
    │     ├─ 内容过滤：
    │     │   ├─ 长度 < 50字 → 跳过(可能是寒暄)
    │     │   ├─ 纯问答型("X是什么") → 可选跳过
    │     │   └─ 包含代码/方案/决策/总结 → 保留
    │     │
    │     └─ 去重检查：
    │         hash(user_msg + assistant_msg) 
    │         是否已存在于 write_log 表？
    │         ├─ 是 → 跳过
    │         └─ 否 → 继续
    │
    ├─ 3. 写入路由决策（核心逻辑）
    │     │
    │     │  输入：用户消息 + AI回答 + 当前会话上下文
    │     │
    │     ├─ Step 3a: 检查用户显式指令
    │     │   │
    │     │   │  扫描用户消息中的指令模式：
    │     │   │  "记到日记里" → target: daily_note
    │     │   │  "保存到XX项目" → target: search("XX项目")
    │     │   │  "更新XX文档" → target: update mode
    │     │   │  "不用记录" / "别保存" → skip write
    │     │   │
    │     │   ├─ 找到指令 → 进入 Step 4
    │     │   └─ 没有指令 → 继续 Step 3b
    │     │
    │     ├─ Step 3b: 规则引擎匹配
    │     │   │
    │     │   │  遍历配置的 routing.rules：
    │     │   │
    │     │   │  Rule 1: keywords=["日记","今天","记录"]
    │     │   │    → match? → target: daily_note
    │     │   │
    │     │   │  Rule 2: keywords=["会议","meeting"]  
    │     │   │    → match? → target: /工作/会议记录
    │     │   │
    │     │   │  Rule 3: keywords=["TODO","任务","待办"]
    │     │   │    → match? → target: /GTD/任务箱
    │     │   │
    │     │   │  Rule 4: keywords=["代码","bug","feature"]
    │     │   │    → match? → target: /开发笔记/{project}
    │     │   │
    │     │   ├─ 命中规则 → 进入 Step 4
    │     │   └─ 无命中 → 继续 Step 3c
    │     │
    │     ├─ Step 3c: 上下文关联匹配
    │     │   │
    │     │   │  如果 before_agent_start 阶段召回了笔记，
    │     │   │  说明这轮对话和某些文档强相关。
    │     │   │
    │     │   │  检查召回阶段的 top-1 文档：
    │     │   │  ├─ /项目/Rust重构 (score: 0.85)
    │     │   │  │
    │     │   │  │  score > 0.7 且文档最近7天有编辑？
    │     │   │  │  → 追加到该文档
    │     │   │  │
    │     │   │  └─ 否则 → 继续 Step 3d
    │     │   │
    │     │   ├─ 有关联文档 → 进入 Step 4
    │     │   └─ 无关联 → 继续 Step 3d
    │     │
    │     └─ Step 3d: 兜底收件箱
    │           target: /OpenClaw/收件箱
    │           writeMode: append
    │
    ├─ 4. 内容格式化
    │     │
    │     ├─ 根据写入目标选择格式模板：
    │     │
    │     │  ┌─ daily_note 模板 ──────────────┐
    │     │  │                                 │
    │     │  │  ### 14:30 与 AI 讨论 Rust 重构  │
    │     │  │                                 │
    │     │  │  **问题**: 上周 Rust 项目进展     │
    │     │  │                                 │
    │     │  │  **要点**:                       │
    │     │  │  - 模块A重构完成，性能提升30%    │
    │     │  │  - 模块B有3个TODO待处理         │
    │     │  │  - 建议优先处理内存泄漏问题      │
    │     │  │                                 │
    │     │  │  #openclaw #rust-project         │
    │     │  └─────────────────────────────────┘
    │     │
    │     │  ┌─ append 模板 ──────────────────┐
    │     │  │                                 │
    │     │  │  ---                            │
    │     │  │  *2026-02-14 14:30 via OpenClaw*│
    │     │  │                                 │
    │     │  │  [对话内容，根据上下文精简]       │
    │     │  │                                 │
    │     │  └─────────────────────────────────┘
    │     │
    │     │  ┌─ inbox 模板 ───────────────────┐
    │     │  │                                 │
    │     │  │  ### 📥 Rust 项目进展回顾        │
    │     │  │  *来源: WhatsApp | 2026-02-14*  │
    │     │  │  *建议归档到: /项目/Rust重构*    │
    │     │  │                                 │
    │     │  │  [完整对话摘要]                  │
    │     │  │                                 │
    │     │  │  #待整理                         │
    │     │  └─────────────────────────────────┘
    │     │
    │     └─ 最终输出: markdown 字符串 + 目标信息
    │
    ├─ 5. 执行写入
    │     │
    │     ├─ 目标文档是否存在？
    │     │   POST /api/query/sql
    │     │   "SELECT * FROM blocks WHERE type='d' 
    │     │    AND hpath = '{target_path}'"
    │     │   │
    │     │   ├─ 存在 → 拿到 doc_id
    │     │   │
    │     │   └─ 不存在 → 创建文档
    │     │       POST /api/filetree/createDocWithMd
    │     │       {
    │     │         notebook: "notebook_id",
    │     │         path: "/OpenClaw/收件箱",
    │     │         markdown: ""
    │     │       }
    │     │       → 拿到新 doc_id
    │     │
    │     ├─ 根据 writeMode 执行：
    │     │   │
    │     │   ├─ append:
    │     │   │   POST /api/block/appendBlock
    │     │   │   {
    │     │   │     data: formatted_markdown,
    │     │   │     dataType: "markdown",
    │     │   │     parentID: doc_id
    │     │   │   }
    │     │   │
    │     │   ├─ child_doc:
    │     │   │   POST /api/filetree/createDocWithMd
    │     │   │   {
    │     │   │     notebook: notebook_id,
    │     │   │     path: "/target/path/新文档标题",
    │     │   │     markdown: formatted_markdown
    │     │   │   }
    │     │   │
    │     │   └─ update:
    │     │       POST /api/block/updateBlock
    │     │       {
    │     │         id: target_block_id,
    │     │         data: updated_content,
    │     │         dataType: "markdown"
    │     │       }
    │     │
    │     └─ 写入块属性（标记来源）
    │         POST /api/attr/setBlockAttrs
    │         {
    │           id: new_block_id,
    │           attrs: {
    │             "custom-source": "openclaw",
    │             "custom-session": session_id,
    │             "custom-channel": "whatsapp",
    │             "custom-timestamp": "1739520600"
    │           }
    │         }
    │
    ├─ 6. 写入后处理
    │     │
    │     ├─ 记录写入日志（防重复）
    │     │   INSERT INTO write_log
    │     │   (hash, doc_id, block_id, timestamp)
    │     │
    │     ├─ 更新本地索引
    │     │   INSERT/UPDATE doc_registry
    │     │   INSERT INTO block_fts
    │     │
    │     └─ 可选：通知用户
    │         "✅ 已记录到 /项目/Rust重构"
    │         (通过原消息渠道回复)
    │
    ▼
流程结束
第四阶段：特殊事件处理
command:new (用户执行 /new 重置会话)
    │
    ├─ 如果 captureStrategy = "full_session"
    │   → 将当前完整会话归档到 /OpenClaw/对话归档/
    │     创建子文档: /OpenClaw/对话归档/2026-02-14_Rust项目讨论
    │
    └─ 重置会话相关状态

思源笔记断开/重连
    │
    ├─ 定时健康检查失败
    │   → siyuanAvailable = false
    │   → 后续写入缓存到本地队列
    │
    └─ 健康检查恢复
        → siyuanAvailable = true
        → 刷新本地缓存队列，批量写入
        → 执行增量索引同步
数据流全景图
用户 (WhatsApp/Telegram/Slack/...)
  │
  │ "帮我回顾上周Rust项目进展"
  │
  ▼
┌──────────────────────────────────────────────────────┐
│                   OpenClaw Gateway                    │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │           SiYuan Lifecycle Plugin                │ │
│  │                                                  │ │
│  │  before_agent_start:                             │ │
│  │  ┌──────────┐   ┌──────────┐   ┌──────────┐    │ │
│  │  │ 意图解析  │ → │ 多路搜索  │ → │ 结果聚合  │    │ │
│  │  └──────────┘   └──────────┘   └──────────┘    │ │
│  │       │               │              │          │ │
│  │       │         ┌─────┴─────┐        │          │ │
│  │       │         │           │        │          │ │
│  │       │    思源API     本地FTS       │          │ │
│  │       │         │           │        │          │ │
│  │       │         └─────┬─────┘        │          │ │
│  │       │               │              │          │ │
│  │       └──prependContext: 笔记上下文──┘          │ │
│  │                       │                         │ │
│  │                       ▼                         │ │
│  │              ┌─────────────────┐                │ │
│  │              │    Pi Agent     │                │ │
│  │              │   (AI 推理)     │                │ │
│  │              └────────┬────────┘                │ │
│  │                       │                         │ │
│  │  agent_end:           ▼                         │ │
│  │  ┌──────────┐   ┌──────────┐   ┌──────────┐   │ │
│  │  │ 内容过滤  │ → │ 路由决策  │ → │ 格式化    │   │ │
│  │  └──────────┘   └──────────┘   └──────────┘   │ │
│  │       │               │              │         │ │
│  │       │          4层路由:             │         │ │
│  │       │          显式指令             │         │ │
│  │       │          规则匹配             │         │ │
│  │       │          上下文关联            │         │ │
│  │       │          兜底收件箱            │         │ │
│  │       │               │              │         │ │
│  │       └───────写入思源 API────────────┘         │ │
│  │                       │                         │ │
│  └───────────────────────┼─────────────────────────┘ │
│                          │                            │
└──────────────────────────┼────────────────────────────┘
                           │
                           ▼
              ┌──────────────────────┐
              │     思源笔记          │
              │  127.0.0.1:6806      │
              │                      │
              │  📓 日记本            │
              │    📄 2026-02-14     │
              │  📓 项目              │
              │    📄 Rust重构  ←──── 写入
              │  📓 OpenClaw         │
              │    📄 收件箱          │
              │    📄 对话归档        │
              └──────────────────────┘

---
这个流程覆盖了从初始化、索引构建、召回、路由决策、写入到异常处理的完整链路。最复杂的部分是写入路由（Step 3），它的四层降级策略确保了在任何情况下内容都能找到合适的归宿，同时给了用户足够的控制权。
要不要我开始写 MVP 版本的代码？我建议先实现核心路径：思源 SQL 搜索召回 + 规则路由 + 收件箱兜底，跑通基本流程后再迭代。
