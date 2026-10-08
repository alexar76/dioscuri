#!/usr/bin/env bash
# Put a new GitHub token into DIOSCURI on admin-vps without the token ever touching argv, a chat or a log.
#
#   dioscuri/scripts/set_github_token.sh
#
# The token is read with a hidden prompt, checked against api.github.com (must answer 200 and have the
# 5000/h limit), then streamed over ssh stdin into /root/dioscuri/.env (GITHUB_TOKEN=, previous file kept
# as .env.bak-<timestamp>, mode 600), and the bot is recreated. Only lengths, HTTP codes and log lines
# are printed. The bot needs NO permissions: a fine-grained token with "Public repositories (read-only)".
set -euo pipefail

read -rsp "GitHub token (input hidden): " TOKEN; echo
TOKEN="${TOKEN//[[:space:]]/}"
re='^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$'
[[ "$TOKEN" =~ $re ]] || { echo "does not look like a GitHub token" >&2; exit 1; }

# -H @- reads the header from stdin, so the token is not in curl's argv.
check=$(printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -s -m 20 -H @- -H 'Accept: application/vnd.github+json' \
  -w '\n%{http_code}' https://api.github.com/rate_limit)
code=${check##*$'\n'}
limit=$(printf '%s' "${check%$'\n'*}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["resources"]["core"]["limit"])' 2>/dev/null || echo "?")
echo "GitHub answers $code with this token, core limit $limit/h"
[[ "$code" == 200 && "$limit" == 5000 ]] || { echo "token rejected or not authenticated — nothing changed" >&2; exit 1; }

REMOTE=$(cat <<'PY'
import os, re, shutil, sys, time
token = sys.stdin.read().strip()
assert re.fullmatch(r"(github_pat_|ghp_)[A-Za-z0-9_]{20,}", token), "bad token on stdin"
env = "/root/dioscuri/.env"
shutil.copy2(env, f"{env}.bak-{time.strftime('%Y%m%d-%H%M%S')}")
lines = open(env).read().splitlines()
out, done = [], False
for line in lines:
    if line.startswith("GITHUB_TOKEN="):
        out.append(f"GITHUB_TOKEN={token}"); done = True
    else:
        out.append(line)
if not done:
    out.append(f"GITHUB_TOKEN={token}")
tmp = env + ".new"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("\n".join(out) + "\n")
os.replace(tmp, env)
print("env updated, mode 600")
PY
)
# The writer travels as a file, the token as the second stdin — no quoting games over ssh.
printf '%s' "$REMOTE" | ssh -o BatchMode=yes -o ConnectTimeout=30 -J not-my-vps admin-vps 'cat > /root/.dioscuri-set-token.py'
printf '%s' "$TOKEN" | ssh -o BatchMode=yes -o ConnectTimeout=30 -J not-my-vps admin-vps \
  'python3 /root/.dioscuri-set-token.py; rc=$?; rm -f /root/.dioscuri-set-token.py; exit $rc'
unset TOKEN

ssh -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=5 -J not-my-vps admin-vps '
  cd /root/dioscuri && docker compose -f docker-compose.yml up -d --no-build --no-deps dioscuri 2>&1 | tail -1
  timeout 150 bash -c "until [ \"\$(docker inspect dioscuri -f {{.State.Health.Status}})\" = healthy ]; do sleep 5; done"
  docker inspect dioscuri -f "health={{.State.Health.Status}} restarts={{.RestartCount}}"
  docker exec dioscuri node -e "console.log(\"token length in container:\", (process.env.GITHUB_TOKEN||\"\").length)"
  echo "waiting 90 s for the first knowledge-base sync..."; sleep 90
  docker logs --since 3m dioscuri 2>&1 | grep -E "dioscuri.mnemosyne" | cut -c1-200 | tail -5'
