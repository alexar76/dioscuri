# DIOSCURI — manual de despliegue y operación (ES)

Runbook práctico para el operador. English version: [runbook.md](runbook.md).
Referencias profundas en inglés: [setup.md](setup.md), [usage.md](usage.md),
[security.md](security.md), [architecture.md](architecture.md).
Versión en ruso: [runbook-ru.md](runbook-ru.md).

## 1. Qué es esto

Un contenedor Docker con los agentes comunitarios del ecosistema AICOM:

- **CÁSTOR** en Telegram (rápido, terrenal), **PÓLUX** en Discord (profundo,
  estructurado). Memoria y escudo compartidos.
- **MNEMOSYNE** — base de conocimiento: se sincroniza sola con GitHub (README,
  releases, digest de commits de 14 días) y con demos públicas del ecosistema.
- **AEGIS** — firewall anti prompt-injection (EN+RU) + moderación. Cerebro sin
  herramientas: un mensaje público no puede ejecutar nada.
- **THEOXENIA** — calendario de contenido: spots, banter cruzado, encuestas,
  digests — automático según horario semanal. Contenido proactivo en inglés;
  en respuestas el bot refleja el idioma de la pregunta.
- **KERYX** — sindicación de releases a Bluesky/Mastodon/X + artículo mensual en
  dev.to. Solo publicación en cuentas propias, sin automatización de engagement.

Garantías duras: **ban imposible** (máximo: aviso / borrado / timeout ≤10 min /
escalar a humanos), cada acción en cadena hash de auditoría, límites diarios de
LLM y posts.

## 2. Qué necesitas

| Qué | Para qué | ¿Obligatorio? |
|---|---|---|
| Servidor con Docker + docker compose | el servicio (~150–300 MB RAM) | sí |
| Clave LLM: `DEEPSEEK_API_KEY` (defecto) u otra | respuestas, contenido, clasificador | sí |
| Bot Discord (token + ID del servidor) | Pólux | al menos una plataforma |
| Bot Telegram (token + ID del grupo) | Cástor | al menos una plataforma |
| `GITHUB_TOKEN` (PAT read-only) | límites API 60/h → 5000/h | recomendado |
| Claves Bluesky/Mastodon/X/dev.to | sindicación KERYX | no (duerme en silencio) |

## 3. Inicio rápido (10 minutos)

```bash
git clone https://github.com/alexar76/dioscuri.git && cd dioscuri
cp .env.example .env
cp dioscuri.config.example.json dioscuri.config.json
docker compose up -d --build
curl -s http://localhost:8790/health
docker logs -f dioscuri
```

Mínimo en `.env`: una clave LLM + tokens de plataforma. Mínimo en
`dioscuri.config.json`: `links.discordInvite` y `links.telegramChannel` reales.

Sin ningún token: `DIOSCURI_DRY_RUN=1` — KB + health (útil para probar el entorno).

## 4. Tokens de plataforma

### Discord (Pólux)
1. [discord.com/developers/applications](https://discord.com/developers/applications) →
   New Application → pestaña **Bot** → Reset Token → `DISCORD_BOT_TOKEN`.
2. Activar **Message Content Intent** y **Server Members Intent**.
3. OAuth2 → URL Generator: scopes `bot` + `applications.commands`; permisos:
   Manage Channels, Manage Roles, Manage Messages, Moderate Members,
   Send Messages, Read Message History, Embed Links, Attach Files, Add Reactions.
4. Copiar ID del servidor = `DISCORD_GUILD_ID`.
5. Tras el primer arranque, subir el rol del bot **por encima** del rol `Keeper`.

Los canales no hace falta crearlos a mano: Pólux levanta la estructura en el
primer boot (THE GATES / AGORA / FORGE / SKY HALL / THE WATCH). Desactivar con
`DISCORD_AUTOSTRUCTURE=0`.

### Telegram (Cástor)
1. [@BotFather](https://t.me/BotFather) → `/newbot` → token = `TELEGRAM_BOT_TOKEN`.
2. Añadir el bot al grupo como **administrador** (borrar mensajes, bloquear, fijar).
3. `TELEGRAM_CHAT_ID`: reenviar un mensaje del grupo a [@userinfobot](https://t.me/userinfobot).

## 5. Primer arranque (automático)

1. Pólux construye la estructura del servidor; Cástor configura menú de comandos.
2. Manifiestos de bienvenida (una vez, flag en `/data`).
3. MNEMOSYNE siembra la KB desde GitHub (primer pase sin spam histórico).
4. Showcase en vivo empieza a sondear demos (monitor cada 10 min).
5. Calendario de contenido activo con quiet hours 22:00–07:00 UTC.

Comprobar: `curl :8790/health` → `adapters.telegram/discord: true`, `kb.chunks > 0`.

## 6. Operación diaria

### Encolar tema para un post
Archivo `/data/content-queue.json` dentro del volumen `dioscuri-data`:
```json
[
  { "kind": "spotlight", "topic": "nuevo oráculo FOURIER y para qué sirve" }
]
```

### Preguntas y respuestas
Discord: mención, reply o `/ask`; Telegram: DM, mención, reply, `/ask`.
Idioma de respuesta = idioma de la pregunta; defecto inglés. Límite: 4 msg/min
por usuario.

### Moderación
Reglas deterministas primero; clasificador LLM solo consultivo.
**Ban nunca automático** — peor caso: escalar a `#mod-log` para humanos.

### Sindicación (KERYX)
Claves en `.env`, reiniciar: `BLUESKY_*`, `MASTODON_*`, `X_SYNDICATION=1` + claves X
(de pago), `DEVTO_API_KEY` para digest mensual.

### Auditoría y salud
- Acciones en `/data/audit.jsonl` con cadena hash.
- Monitorizar `GET :8790/health` y logs `error`.

### Actualizar y backup
```bash
git pull && docker compose up -d --build
docker run --rm -v dioscuri_dioscuri-data:/data -v $PWD:/backup alpine \
  tar czf /backup/dioscuri-data.tgz /data
```

## 7. Troubleshooting

| Síntoma | Causa → solución |
|---|---|
| `Used disallowed intents` | activar intents en la pestaña Bot |
| Bot no crea canales | permisos Manage Channels/Roles o rol bajo |
| Moderación Telegram muda | bot no es admin del grupo |
| `GitHub rate limited` | añadir `GITHUB_TOKEN` |
| LLM 401 | clave no coincide con `DIOSCURI_LLM_PROVIDER` |
| Puerto 8790 ocupado | cambiar `DIOSCURI_HTTP_PORT` |

## 8. Líneas rojas (nunca)

- Auto-bump DISBOARD, self-bots, automatización de cuentas de usuario.
- Comprar miembros/seguidores/boosts.
- DMs masivos a desconocidos.
- Secretos solo en `.env`; nunca en `dioscuri.config.json`.
