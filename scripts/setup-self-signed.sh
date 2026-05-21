#!/bin/bash
# Creates a self-signed code-signing cert in the user's login keychain so
# electron-builder can sign Clawd with a stable identity. macOS Gatekeeper
# will still warn on first install (only a paid Apple Developer ID removes
# that), but TCC permissions like Screen Recording will persist across
# rebuilds because the signing identity is stable.

set -euo pipefail

CERT_CN="Clawd Self-Signed"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
P12_PASS="clawd-import-tmp"

TMP_DIR=$(mktemp -d)
trap "rm -rf '$TMP_DIR'" EXIT

KEY="$TMP_DIR/key.pem"
CRT="$TMP_DIR/cert.pem"
P12="$TMP_DIR/cert.p12"

cat > "$TMP_DIR/ext.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ext
[dn]
CN = Clawd Self-Signed
[v3_ext]
basicConstraints = CA:FALSE
keyUsage = digitalSignature
extendedKeyUsage = codeSigning
EOF

# Wipe any previous copies so repeated runs don't pile up duplicates.
while security delete-identity -c "$CERT_CN" "$KEYCHAIN" 2>/dev/null; do :; done
while security delete-certificate -c "$CERT_CN" "$KEYCHAIN" 2>/dev/null; do :; done

echo "Generating self-signed code-signing cert..."
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$KEY" -out "$CRT" \
  -days 3650 \
  -config "$TMP_DIR/ext.cnf" >/dev/null 2>&1

# macOS's stock LibreSSL and Homebrew's OpenSSL 3 disagree on PKCS12 flags.
# OpenSSL 3 needs -legacy plus explicit SHA1/3DES because its new defaults
# aren't accepted by macOS's keychain. LibreSSL doesn't know -legacy and its
# defaults already match what the keychain expects, so we skip the flags.
if openssl version 2>/dev/null | grep -qE "^OpenSSL 3"; then
  openssl pkcs12 -export -legacy \
    -inkey "$KEY" -in "$CRT" \
    -out "$P12" -passout "pass:$P12_PASS" \
    -name "$CERT_CN" \
    -macalg sha1 \
    -keypbe PBE-SHA1-3DES \
    -certpbe PBE-SHA1-3DES
else
  openssl pkcs12 -export \
    -inkey "$KEY" -in "$CRT" \
    -out "$P12" -passout "pass:$P12_PASS" \
    -name "$CERT_CN"
fi

echo "Importing identity into login keychain..."
security import "$P12" \
  -k "$KEYCHAIN" \
  -P "$P12_PASS" \
  -T /usr/bin/codesign \
  -T /usr/bin/security

# Let codesign use the key without the per-build "always allow" GUI prompt.
security set-key-partition-list \
  -S "apple-tool:,apple:,codesign:" \
  -s -k "" "$KEYCHAIN" 2>/dev/null || true

echo "Adding trust setting (you may see a password prompt)..."
security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$CRT"

echo
if security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "$CERT_CN"; then
  echo "Cert installed and trusted as: $CERT_CN"
  echo "Run: npm run pack"
else
  echo "WARNING: cert imported but not visible as a valid codesigning identity"
  exit 1
fi
