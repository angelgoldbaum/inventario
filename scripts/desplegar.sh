#!/usr/bin/env bash
# Publica la app en Firebase usando una cuenta de servicio.
#   Uso:  FIREBASE_SERVICE_ACCOUNT='<json>' ./scripts/desplegar.sh <ID-del-proyecto>
#   (o GOOGLE_APPLICATION_CREDENTIALS=/ruta/llave.json)
#   Sin llave: usa la sesión de "npx firebase login" en su computadora.
# Opcional: UBICACION=nam5 (región de Firestore, sólo se usa la primera vez)
set -euo pipefail
cd "$(dirname "$0")/.."

PROYECTO="${1:?Indique el ID del proyecto de Firebase}"
UBICACION="${UBICACION:-nam5}"
FB="npx --no-install firebase"

if [[ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]]; then
  if [[ -n "${FIREBASE_SERVICE_ACCOUNT:-}" ]]; then
  LLAVE="$(mktemp)"; chmod 600 "$LLAVE"; trap 'rm -f "$LLAVE"' EXIT
  printf '%s' "$FIREBASE_SERVICE_ACCOUNT" > "$LLAVE"
  export GOOGLE_APPLICATION_CREDENTIALS="$LLAVE"
  else
    echo "(sin llave: se usa la sesión de firebase login)"
  fi
fi

echo "== Compilando"
npm run build >/dev/null

echo "== App web (necesaria para la configuración del cliente)"
if ! $FB apps:list WEB --project "$PROYECTO" 2>/dev/null | grep -q "WEB"; then
  $FB apps:create WEB "Inventarios" --project "$PROYECTO"
fi

echo "== Base de datos Firestore"
if ! $FB firestore:databases:list --project "$PROYECTO" 2>/dev/null | grep -q "(default)"; then
  $FB firestore:databases:create "(default)" --location "$UBICACION" --project "$PROYECTO"
fi

echo "== Inicio de sesión con correo/contraseña"
TOKEN="$(node -e '
  const { GoogleAuth } = require("google-auth-library");
  new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getAccessToken().then(t => console.log(t)).catch(() => process.exit(1));
' 2>/dev/null || true)"
ACTIVADO=no
if [[ -n "$TOKEN" ]]; then
  BASE="https://identitytoolkit.googleapis.com/admin/v2/projects/$PROYECTO"
  curl -sf -X POST -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROYECTO" "$BASE/identityPlatform:initializeAuth" >/dev/null 2>&1 || true
  if curl -sf -X PATCH -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROYECTO" -H "Content-Type: application/json" \
      "$BASE/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired" \
      -d '{"signIn":{"email":{"enabled":true,"passwordRequired":true}}}' >/dev/null; then
    ACTIVADO=si
  fi
fi
[[ "$ACTIVADO" == si ]] && echo "   activado" || echo "   ⚠ No se pudo activar automáticamente: en la consola de Firebase vaya a Authentication > Método de acceso > Correo electrónico/contraseña > Habilitar"

echo "== Publicando reglas, índices y sitio"
$FB deploy --only hosting,firestore:rules,firestore:indexes --project "$PROYECTO" --non-interactive

echo
echo "Listo:  https://$PROYECTO.web.app/pc   (PC)     https://$PROYECTO.web.app/m   (celulares)"
