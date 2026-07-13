# DIOSCURI — мануал по развертыванию и эксплуатации (RU)

Практический раннбук для оператора. English version: [runbook.md](runbook.md).
Versión en español: [runbook-es.md](runbook-es.md).
Подробные справочники — на английском: [setup.md](setup.md) (полная настройка),
[usage.md](usage.md) (эксплуатация), [security.md](security.md) (модель
защиты), [architecture.md](architecture.md).

## 1. Что это

Один Docker-контейнер, внутри — близнецы-агенты сообщества AICOM-экосистемы:

- **CASTOR** ведёт Telegram (быстрый, приземлённый), **POLLUX** ведёт Discord
  (глубокий, структурный). Общая память и общий щит.
- **MNEMOSYNE** — база знаний: сама синхронизируется с GitHub (README, релизы,
  дайджест коммитов за 14 дней) и с живыми демо-эндпоинтами экосистемы.
- **AEGIS** — файрвол от промпт-инъекций (EN+RU) + модерация. Мозг без
  инструментов: публичное сообщение физически не может ничего запустить.
- **THEOXENIA** — контент-календарь: споты, кросс-платформенный бантер, опросы,
  дайджесты — само, по недельному расписанию. Весь проактивный контент —
  английский; в ответах бот зеркалит язык вопроса.
- **KERYX** — синдикация релизов в Bluesky/Mastodon/X + месячная статья на
  dev.to. Только постинг в свои аккаунты, никакой накрутки.

Жёсткие гарантии: **бан невозможен** (максимум действий бота: предупреждение /
удаление / таймаут ≤10 мин / эскалация людям), каждое действие — в
хеш-цепочке аудита, дневные лимиты на LLM-вызовы и посты.

## 2. Что нужно

| Что | Зачем | Обязательно? |
|---|---|---|
| Сервер с Docker + docker compose | сам сервис (~150–300 МБ RAM) | да |
| LLM-ключ: `DEEPSEEK_API_KEY` (дефолт) или anthropic/openai/локальный ollama | ответы, контент, классификатор модерации | да |
| Discord-бот (токен + ID сервера) | Поллукс | хотя бы одна платформа |
| Telegram-бот (токен + ID группы) | Кастор | хотя бы одна платформа |
| `GITHUB_TOKEN` (read-only PAT) | лимиты GitHub API 60/ч → 5000/ч | желательно |
| Ключи Bluesky/Mastodon/X/dev.to | синдикация KERYX | нет (молча спит) |

## 3. Быстрый старт (10 минут)

```bash
git clone <gitea>/alexar76/dioscuri.git && cd dioscuri   # или папка dioscuri/ монорепо
cp .env.example .env                        # секреты — только сюда
cp dioscuri.config.example.json dioscuri.config.json     # тюнинг — сюда
# отредактировать оба файла (минимум см. ниже), затем:
docker compose up -d --build
curl -s http://localhost:8790/health        # {"ok":true,...} = живой
docker logs -f dioscuri                     # JSON-логи; ищи "waking the twins"
```

Минимум в `.env`: один LLM-ключ + токены платформ. Минимум в
`dioscuri.config.json`: реальные `links.discordInvite` и
`links.telegramChannel` — на них построено всё кросс-промо.

Без единого токена сервис тоже запускается: `DIOSCURI_DRY_RUN=1` — поднимутся
база знаний и health (удобно для проверки окружения).

## 4. Токены платформ

### Discord (Поллукс)
1. [discord.com/developers/applications](https://discord.com/developers/applications) →
   New Application → вкладка **Bot** → Reset Token → это `DISCORD_BOT_TOKEN`.
2. Там же включить **Message Content Intent** (без него бот не видит текст —
   не будет ни ответов, ни модерации) и **Server Members Intent** (приветствия,
   таймауты).
3. OAuth2 → URL Generator: scopes `bot` + `applications.commands`; права:
   Manage Channels, Manage Roles, Manage Messages, Moderate Members,
   Send Messages, Read Message History, Embed Links, Attach Files,
   Add Reactions. Открыть ссылку → выбрать сервер → Authorize.
4. В Discord: Настройки → Расширенные → Режим разработчика → правый клик по
   серверу → Копировать ID = `DISCORD_GUILD_ID`.
5. После первого запуска поднять роль бота **выше** роли `Keeper` в списке
   ролей (иначе не сможет управлять ролями/таймаутами).

Каналы указывать не нужно: при первом старте Поллукс сам создаст структуру
(THE GATES / AGORA / FORGE / SKY HALL / THE WATCH, роль Keeper, права,
закреплённый манифест). Повторный запуск ничего не ломает — только долечивает.
Отключается флагом `DISCORD_AUTOSTRUCTURE=0`.

### Telegram (Кастор)
1. [@BotFather](https://t.me/BotFather) → `/newbot` → токен = `TELEGRAM_BOT_TOKEN`.
2. Добавить бота в группу **администратором** (права: удаление сообщений,
   блокировка участников, закрепление).
3. `TELEGRAM_CHAT_ID`: переслать любое сообщение группы боту
   [@userinfobot](https://t.me/userinfobot); для супергрупп ID вида `-100…`.

## 5. Что произойдёт при первом запуске (само)

1. Поллукс строит структуру сервера, Кастор настраивает меню команд и
   закрепляет ссылки.
2. Близнецы публикуют вступительные манифесты (один раз, флаг в `/data`).
3. MNEMOSYNE засеивает базу знаний из GitHub (первый проход — без анонсов,
   спамить историческими релизами не будет).
4. Живая витрина начинает опрашивать демо-эндпоинты (монитор — каждые 10 мин).
5. Контент-календарь взводится: пн/чт спотлайт, вт/сб бантер, ср опрос,
   пт дайджест «This week in the forge», вс show-and-tell. Тихие часы
   22:00–07:00 UTC, максимум 3 поста/платформу/день.

Проверка: `curl :8790/health` → `adapters.telegram/discord: true`,
`kb.chunks > 0`. В логах: `POLLUX holds the sky`, `CASTOR rides the ground`,
`KB sync pass complete`.

## 6. Повседневная эксплуатация

### Подкинуть тему для поста
Положить в `/data/content-queue.json` (внутри тома `dioscuri-data`):
```json
[
  { "kind": "spotlight", "topic": "новый оракул FOURIER и зачем он нужен" },
  { "topic": "тема без kind — уйдёт в любой ближайший слот" }
]
```
Очередь съедается раньше ротации тем. Постоянные темы и расписание —
`topics` и `slots` в `dioscuri.config.json` (перезапуск контейнера).

### Ответы на вопросы
Discord: упоминание бота, реплай или `/ask`; Telegram: личка, упоминание,
реплай, `/ask`. Язык ответа = язык вопроса, дефолт английский. Лимиты:
4 сообщения/мин на пользователя (сверх — вежливый отказ без LLM-вызова).

### Модерация
Детерминированные правила решают первыми: чужие инвайты (удаление),
масс-упоминания и флуд (удаление + таймаут ≤10 мин), спам-повторы, капс.
LLM-классификатор — только совещательный и только при риск-сигналах.
**Бан — никогда автоматически**: худший случай — эскалация в `#mod-log`
с пометкой для живых модераторов. Обход для модераторов встроен.

### Синдикация (KERYX)
Появились аккаунты — вписать ключи в `.env`, перезапустить:
`BLUESKY_IDENTIFIER`+`BLUESKY_APP_PASSWORD`, `MASTODON_BASE_URL`+
`MASTODON_ACCESS_TOKEN` (в профиле включить флаг «bot»), для X —
`X_SYNDICATION=1` + четыре ключа (платно: ~$0.015/пост, $0.20 со ссылкой),
`DEVTO_API_KEY` для месячного дайджеста. В логе: `KERYX armed`.
Каждый новый релиз на GitHub уйдёт коротким анонсом во все живые синки.

DISBOARD: если сервер залистить и добавить их бота, Поллукс будет напоминать
Keeper'ам про `/bump` через 2 часа после удачного бампа. **Авто-бамп не
делается и не должен делаться** — это делистинг + бан аккаунта.

### Живая витрина
Добавить источник — в `dioscuri.config.json`:
```json
"showcase": { "sources": [
  { "name": "alien-monitor", "url": "https://magic-ai-factory.com/monitor/api/health", "kind": "json" }
]}
```
Перед добавлением проверить руками: `curl <url>` должен отдавать JSON.
Секретоподобные ключи (`token`, `api_key`, `seed`…) в базу не попадают никогда.

### Аудит и здоровье
- Все действия — `/data/audit.jsonl`, хеш-цепочка. Проверка целостности
  (напечатает `audit chain intact`, при подделке — номер сломанной записи):

  ```bash
  docker exec dioscuri node -e "
  import('/app/dist/audit.js').then(async ({ FileAuditLog }) => {
    const log = { debug(){}, info(){}, warn(){}, error(){}, child() { return log; } };
    const broken = await new FileAuditLog(process.env.DIOSCURI_DATA_DIR || '/data', log).verify();
    console.log(broken === -1 ? 'audit chain intact' : 'chain broken at entry ' + broken);
    process.exit(broken === -1 ? 0 : 1);
  });"
  ```
- Мониторить: `GET :8790/health` (алерт на `ok:false` или падение
  `adapters.*` в `false`), JSON-логи уровня `error`.

### Обновление и бэкап
```bash
git pull && docker compose up -d --build     # обновление
docker run --rm -v dioscuri_dioscuri-data:/data -v $PWD:/backup alpine \
  tar czf /backup/dioscuri-data.tgz /data    # бэкап тома (KB, аудит, стейт)
```

## 7. Траблшутинг

| Симптом | Причина → лечение |
|---|---|
| `Used disallowed intents` при старте | не включены интенты на вкладке Bot (п. 4.2) |
| Бот не создаёт каналы/роль | нет прав Manage Channels/Roles или роль бота ниже — поднять роль |
| Telegram-модерация молчит | бот не админ группы |
| `GitHub rate limited` в логах | добавить `GITHUB_TOKEN` (read-only PAT) |
| LLM 401 | ключ не от того провайдера: сверить `DIOSCURI_LLM_PROVIDER` и ключ |
| Порт 8790 занят | сменить `DIOSCURI_HTTP_PORT` (и проброс в compose) |
| Опечатка в провайдере | неизвестное имя молча падает в `deepseek` — проверить лог `waking the twins` |

## 8. Красные линии (не делать никогда)

- Авто-бамп DISBOARD, self-bot'ы, автоматизация юзер-аккаунтов — бан.
- Покупка участников/подписчиков/бустов, join4join — Discord сносит серверы,
  Telegram банит номера, метрики вовлечённости умирают.
- Массовые DM/инвайты незнакомцам — спам по правилам обеих платформ.
- Секреты — только в `.env`; в `dioscuri.config.json` секретов быть не должно
  (он монтируется read-only и не считается конфиденциальным).
