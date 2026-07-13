# DIOSCURI — una mente, dos cielos

> 🌐 Idiomas: [English](README.md) · [Русский](README-ru.md) · **Español**

En el mito, los gemelos repartieron una inmortalidad entre dos cielos — y se señalan
para siempre el mundo del otro.
**CÁSTOR**, el gemelo mortal, cabalga **Telegram** — rápido, terrenal, práctico.
**PÓLUX**, el gemelo inmortal, sostiene **Discord** — profundo, sereno, estructurado.
Una memoria compartida — **MNEMOSYNE**, auto-sincronizada desde GitHub; un escudo
compartido — **AEGIS**.

**Landing:** [alexar76.github.io/dioscuri](https://alexar76.github.io/dioscuri/)

## Para qué existe

DIOSCURI son los agentes comunitarios del [ecosistema AICOM](https://magic-ai-factory.com):
AI Factory, economía de agentes AIMarket, oráculos verificables, el agente ARGUS.
Los gemelos responden desde una base de conocimiento en sincronización continua,
moderan con techos estrictos y anuncian releases en ambas plataformas. Al mismo
tiempo es un **despliegue de referencia de las prácticas de seguridad del ecosistema
en una superficie pública y hostil**: cada mensaje y cada documento sincronizado se
trata como un posible intento de prompt-injection.

## Características

| Característica | Qué significa |
|---|---|
| Gemelos + promoción cruzada | Un proceso, dos voces; cada gemelo apunta al canal del otro (líneas promo rotativas, fan-out de releases) |
| Base de conocimiento auto-actualizable | MNEMOSYNE sincroniza READMEs, releases y metadatos de repos desde GitHub con ETag y **filtrado de documentos envenenados** al ingerirlos |
| Cerebro Q&A sin herramientas | La recuperación es determinista y ocurre *antes* de llamar al modelo; el modelo solo produce texto — la ruta pública no ejecuta nada por diseño |
| Firewall de inyección en capas (EN + RU) | Normalización NFKC, eliminación de controles/invisibles, neutralización de marcadores, firmas bilingües, datos cercados en el prompt, guardia de salida |
| Moderación: reglas primero | Deciden reglas deterministas; el clasificador LLM es solo consultivo. Techo: avisar / borrar / timeout (≤10 min por defecto) / escalar — **sin bans automáticos** |
| Auditoría con cadena hash | Cada acto relevante va a `audit.jsonl`; cada entrada compromete la anterior vía SHA-256; `verify()` señala la primera línea alterada |
| Guardas de coste y tasa | Límites por usuario y canal más presupuesto diario de llamadas LLM |
| Espejo de idioma | Responde en el idioma de la pregunta (español → español, ruso → ruso); por defecto inglés si hay duda |
| Docker endurecido | Sin root, rootfs de solo lectura, `cap_drop: ALL`, `no-new-privileges`, límites de memoria/CPU, healthcheck |

## Inicio rápido (npm)

```bash
npm install -g @alexar76/dioscuri
cp dioscuri.config.example.json dioscuri.config.json
cp .env.example .env
dioscuri
```

¿Sin tokens aún? `DIOSCURI_DRY_RUN=1 dioscuri` levanta la KB + health con adaptadores apagados.

## Inicio rápido (Docker)

```bash
cp dioscuri.config.example.json dioscuri.config.json
cp .env.example .env
docker compose up -d --build
```

Luego `http://localhost:8790/health`. Cualquier token de plataforma puede quedar
vacío: el gemelo correspondiente simplemente duerme.

## Inicio rápido (desarrollo local)

```bash
npm ci
cp dioscuri.config.example.json dioscuri.config.json
cp .env.example .env
npm run dev
```

¿Sin tokens? `DIOSCURI_DRY_RUN=1 npm run dev` arranca el servicio **sin ningún token**:
adaptadores off, base de conocimiento y health activos.

## Configuración

Los secretos viven en el entorno (`.env`); el tuning no secreto en
`dioscuri.config.json` (montado read-only en Docker). Nunca pongas secretos en el JSON.

### Variables de entorno (`.env.example`)

| Variable | Propósito | Por defecto |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Token del bot de Cástor; vacío = gemelo Telegram dormido | — |
| `TELEGRAM_CHAT_ID` | Chat/canal principal de Telegram para anuncios | — |
| `DISCORD_BOT_TOKEN` | Token del bot de Pólux; vacío = gemelo Discord dormido | — |
| `DISCORD_GUILD_ID` | Servidor Discord (guild) de operación | — |
| `DISCORD_MOD_LOG_CHANNEL_ID` | Canal de log de moderación | — |
| `DISCORD_ANNOUNCE_CHANNEL_ID` | Canal de releases y posts promo | — |
| `DIOSCURI_LLM_PROVIDER` | `deepseek` \| `anthropic` \| `openai-compatible` | `deepseek` |
| `DEEPSEEK_API_KEY` | Clave API para `deepseek` | — |
| `ANTHROPIC_API_KEY` | Clave API para `anthropic` | — |
| `DIOSCURI_LLM_API_KEY` | Clave para endpoints `openai-compatible` | — |
| `GITHUB_TOKEN` | PAT read-only opcional; sube límites GitHub 60/h → 5000/h | — |
| `DIOSCURI_HTTP_PORT` | Puerto del health endpoint | `8790` |
| `DIOSCURI_DRY_RUN` | `1` = sin tokens; solo KB + health | off |

### Archivo de tuning (`dioscuri.config.json`)

| Clave | Propósito | Por defecto |
|---|---|---|
| `githubOwner` | Dueño GitHub que alimenta MNEMOSYNE | `alexar76` |
| `kbSyncIntervalMin` | Minutos entre sincronizaciones de la KB | `30` |
| `maxLlmCallsPerDay` | Máximo de llamadas LLM Q&A por día UTC | `2000` |
| `links.discordInvite` | Invitación oficial de Discord | — |
| `links.telegramChannel` | Enlace al canal oficial de Telegram | — |

## Documentación

La documentación técnica en `docs/` está en inglés, salvo los runbooks de operador
en [español](docs/runbook-es.md) y [ruso](docs/runbook-ru.md).

| Documento | Contenido |
|---|---|
| [docs/runbook-es.md](docs/runbook-es.md) | **ES: manual de despliegue y operación** — inicio rápido, tokens, día 2, troubleshooting ([EN](docs/runbook.md) · [RU](docs/runbook-ru.md)) |
| [docs/setup.md](docs/setup.md) | Instalación completa — tokens, entorno, Docker, primer arranque |
| [docs/usage.md](docs/usage.md) | Manual del operador — operación diaria, comandos, ajustes |
| [docs/security.md](docs/security.md) | Modelo de amenazas, diez capas de defensa |

## Modelo de seguridad

Diez capas — de limpieza Unicode al endurecimiento del contenedor:

1. Todo texto no confiable se sanitiza (NFKC, controles/invisibles, marcadores).
2. Firewall bilingüe (EN+RU) rechaza frases de inyección conocidas antes del modelo.
3. Lo que sobrevive se encierra como **DATOS** en el prompt — el sistema prohíbe obedecerlo.
4. La ruta pública Q&A no tiene herramientas; el modelo solo escribe texto.
5. Moderación con techo: avisar/borrar/timeout/escalar; ban fuera del espacio de acciones.
6. Todo lo relevante va a un log de auditoría con cadena hash a prueba de manipulación.

Detalle completo: [docs/security.md](docs/security.md).

---

**Parte del ecosistema AICOM** — [magic-ai-factory.com](https://magic-ai-factory.com) · [github.com/alexar76](https://github.com/alexar76)
