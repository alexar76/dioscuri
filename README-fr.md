# DIOSCURI — un esprit, deux cieux

> 🌐 [English](README.md) · [Русский](README-ru.md) · [Español](README-es.md) · **Français** · [中文](README-zh.md) · [Glossaire](https://github.com/alexar76/aicom/blob/main/docs/localization-glossary.md)


Dans le mythe, les jumeaux partagent une immortalité entre deux cieux.
**CASTOR**, le jumeau mortel, chevauche **Telegram** — rapide, ancré, pratique.
**POLLUX**, le jumeau immortel, tient **Discord** — profond, calme, structuré.
Une mémoire partagée — **MNEMOSYNE**, synchronisée depuis GitHub ; un bouclier partagé — **AEGIS**.

**Landing :** [alexar76.github.io/dioscuri](https://alexar76.github.io/dioscuri/)

## Pourquoi ça existe

DIOSCURI sont les agents communauté de l’[écosystème AICOM](https://magic-ai-factory.com) : AI Factory, économie d’agents AIMarket, oracles vérifiables, agent ARGUS. Ils répondent depuis une base de connaissances synchronisée, modèrent avec des plafonds stricts et annoncent les releases sur les deux plateformes. C’est aussi un **déploiement de référence des pratiques de sécurité** sur une surface d’entrée publique hostile : chaque message et chaque document synchronisé est traité comme une prompt-injection potentielle.

## Capacités

| Capacité | Signification |
|---|---|
| Jumeaux + promotion croisée | Un processus, deux voix ; chaque jumeau renvoie vers le canal de l’autre |
| Base de connaissances auto-mise à jour | MNEMOSYNE tire README/releases GitHub avec ETag et **filtre de documents empoisonnés** |
| Cerveau Q&A sans outils | Recherche déterministe *avant* l’appel modèle ; le modèle n’écrit que du texte |
| Pare-feu d’injection multi-couches (EN + RU) | NFKC, contrôles invisibles, signatures bilingues, données clôturées, garde de sortie |
| Modération : règles d’abord | Règles déterministes ; LLM seulement consultatif. Plafond : warn / delete / timeout (≤10 min) / appeler humains — **aucun ban automatique** |
| Audit à chaîne de hachage | `audit.jsonl` ; chaque entrée lie le hash SHA-256 précédent |
| Gardes budget & débit | Limites par utilisateur/canal + budget LLM journalier |
| Miroir de langue | Répond dans la langue de la question |
| Docker durci | non-root, FS lecture seule, `cap_drop: ALL`, `no-new-privileges`, limites mémoire/CPU |

## Démarrage rapide (Docker)

```bash
cp dioscuri.config.example.json dioscuri.config.json
cp .env.example .env
docker compose up -d --build
```

Puis `http://localhost:8790/health`. Un token de plateforme vide endort le jumeau concerné.

## Démarrage rapide (dev local)

```bash
npm ci
cp dioscuri.config.example.json dioscuri.config.json
cp .env.example .env
npm run dev
# sans tokens : DIOSCURI_DRY_RUN=1 npm run dev
```

## Configuration

Secrets dans `.env` ; réglages non secrets dans `dioscuri.config.json` (monté lecture seule en Docker). Jamais de secrets dans le JSON.

Variables clés : `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `DIOSCURI_LLM_PROVIDER` (`deepseek` \| `anthropic` \| `openai-compatible`), `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `DIOSCURI_HTTP_PORT` (défaut `8790`), `DIOSCURI_DRY_RUN`.

## Sécurité

Chaque entrée publique est hostile. AEGIS applique normalisation, signatures bilingues, cloisonnement des données et garde de sortie. La modération ne bannit jamais automatiquement.

## Licence

MIT — [LICENSE](LICENSE).
