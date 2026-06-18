#!/usr/bin/env bash
set -euo pipefail

# Bootstrap de un VPS nuevo (Ubuntu LTS) para Hierbas del Oasis.
# Instala Docker, configura el firewall y clona el repo.
# Uso (como root o usuario con sudo):  bash bootstrap.sh

REPO_URL="https://github.com/MaxiGto/hdo-selling-module.git"

# Usa sudo solo si no sos root.
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

echo "==> Actualizando el sistema..."
$SUDO apt-get update -y
$SUDO DEBIAN_FRONTEND=noninteractive apt-get upgrade -y

echo "==> Instalando dependencias base..."
$SUDO apt-get install -y ca-certificates curl git ufw

echo "==> Configurando firewall (SSH + HTTP + HTTPS)..."
$SUDO ufw allow OpenSSH
$SUDO ufw allow 80/tcp
$SUDO ufw allow 443/tcp
$SUDO ufw --force enable

echo "==> Instalando Docker..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | $SUDO sh
fi
# Permite usar docker sin sudo (efectivo tras re-login).
$SUDO usermod -aG docker "$(id -un)"

echo "==> Clonando el repositorio..."
if [ ! -d hdo-selling-module ]; then
  git clone "$REPO_URL"
fi

cat <<'EOF'

================================================================
  Bootstrap completo.

  Proximos pasos (ver README.md -> "Puesta en marcha"):
    1. cd hdo-selling-module
    2. cp .env.example .env   y completar los valores de PRODUCCION
       (dominio, secretos nuevos, token PERMANENTE de Meta,
        ANTHROPIC_API_KEY, SMTP real)
    3. Apunta el DNS (registro A) de tu dominio a la IP de este VPS
    4. docker compose --profile prod up -d
    5. Preparar la base (solo la 1ra vez):
         docker compose run --rm -e DISABLE_DATABASE_ENVIRONMENT_CHECK=1 \
           rails bundle exec rails db:schema:load
         docker compose run --rm rails bundle exec rails db:seed
         docker compose restart rails sidekiq
    6. Crear admin, inbox de WhatsApp y registrar el Agent Bot
       (README, pasos 6-7)

  NOTA: cerra la sesion SSH y volve a entrar (o 'newgrp docker')
        para usar docker sin sudo.
================================================================
EOF
