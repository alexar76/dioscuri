# DIOSCURI — 一心，两重天

> 🌐 [English](README.md) · [Русский](README-ru.md) · [Español](README-es.md) · [Français](README-fr.md) · **中文** · [术语表](https://github.com/alexar76/aicom/blob/main/docs/localization-glossary.md)


神话里孪生兄弟把同一份不朽分到两片天空。
**CASTOR**（凡胎）驰骋 **Telegram** — 快、落地、务实。
**POLLUX**（不朽）镇守 **Discord** — 深、静、有结构。
共享记忆 **MNEMOSYNE**（自 GitHub 同步）；共享盾牌 **AEGIS**。

**落地页：** [alexar76.github.io/dioscuri](https://alexar76.github.io/dioscuri/)

## 为何存在

DIOSCURI 是 [AICOM 生态](https://magic-ai-factory.com) 的社区智能体：AI Factory、AIMarket 智能体经济、可验证预言机、ARGUS。它们基于持续同步的知识库答疑，以严格上限做 moderation，并在双平台发布发行说明。同时这也是**在公开、默认敌意的输入表面上的安全实践参考部署**：每条消息与每个同步文档都视为潜在 prompt 注入。

## 能力

| 能力 | 含义 |
|---|---|
| 双生子 + 互推 | 一进程两声线；彼此自然导流 |
| 自更新知识库 | MNEMOSYNE 拉取 GitHub README/releases，带 ETag 与**投毒文档过滤** |
| 无工具 Q&A | 模型调用前做确定性检索；模型只写文本 |
| 多层注入防火墙（EN + RU） | NFKC、不可见字符、双语签名、围栏数据、输出守卫 |
| 规则优先的 moderation | 确定性规则拍板；LLM 仅咨询。上限：警告/删除/超时（默认 ≤10 分钟）/呼叫人类 — **绝不自动封禁** |
| 哈希链审计 | `audit.jsonl`；每条记录绑定前一条 SHA-256 |
| 预算与频率守卫 | 每用户/频道限额 + 每日 LLM 预算 |
| 语言镜像 | 用提问语言作答 |
| 加固 Docker | non-root、只读 FS、`cap_drop: ALL`、`no-new-privileges` |

## 快速开始（Docker）

```bash
cp dioscuri.config.example.json dioscuri.config.json
cp .env.example .env
docker compose up -d --build
```

然后访问 `http://localhost:8790/health`。

## 快速开始（本地）

```bash
npm ci && cp dioscuri.config.example.json dioscuri.config.json && cp .env.example .env
npm run dev
# DIOSCURI_DRY_RUN=1 npm run dev  — 无 token
```

## 配置

密钥在 `.env`；非密钥在 `dioscuri.config.json`。切勿把密钥写入 JSON。

## 许可

MIT — [LICENSE](LICENSE).
