#!/usr/bin/env bash
# Create .env with a random database password, once.
# The file is created with umask 077 (mode 600) and is gitignored. The password is never printed.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
if [[ -f .env ]] && grep -q '^SIL_PG_PASSWORD=.' .env; then
  echo ".env already has SIL_PG_PASSWORD [set] - leaving it alone"
  exit 0
fi
if [[ -f .env ]]; then
  echo ".env exists without SIL_PG_PASSWORD: not touching it; add the two lines yourself or move the file" >&2
  exit 1
fi
umask 077
pw="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
if [[ ${#pw} -lt 24 ]]; then
  echo "could not generate a password" >&2
  exit 1
fi
{
  echo "# created by scripts/init-env.sh - do not commit"
  echo "SIL_PG_PASSWORD=${pw}"
  echo "SIL_PG_DSN=postgresql://sil:${pw}@127.0.0.1:5544/insurance"
} > .env
chmod 600 .env
echo "wrote .env: SIL_PG_PASSWORD [set, ${#pw} chars]"
