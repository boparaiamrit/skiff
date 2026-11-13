#!/usr/bin/env bash
# Builds Skiff's APK: the web UI, the Go backend (as a native library) and
# the Android shell. Needs Node, Go and the Android build tools
# (aapt, dx, zipalign, apksigner) plus an android.jar.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$PWD
OUT=$ROOT/build
ANDROID_JAR=${ANDROID_JAR:-$ROOT/android/sdk/android-34.jar}
BT=${BUILD_TOOLS:-/usr/lib/android-sdk/build-tools/debian}
KEYSTORE=${KEYSTORE:-$ROOT/keys/skiff.keystore}
export JAVA_TOOL_OPTIONS=

if [ ! -f "$ANDROID_JAR" ]; then
  echo "==> fetching android.jar (API 34)"
  tmp=$(mktemp -d)
  git clone -q --depth 1 --filter=blob:none --sparse https://github.com/Reginer/aosp-android-jar.git "$tmp/j"
  (cd "$tmp/j" && git sparse-checkout set android-34)
  mkdir -p "$(dirname "$ANDROID_JAR")" && cp "$tmp/j/android-34/android.jar" "$ANDROID_JAR" && rm -rf "$tmp"
fi

rm -rf "$OUT" && mkdir -p "$OUT"/{gen,classes,apk/lib/arm64-v8a}

echo "==> web UI"
(cd web && node build.mjs)

echo "==> backend (linux/arm64, static)"
(cd server && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 GOFLAGS=-mod=mod GOTOOLCHAIN=local \
  go build -trimpath -ldflags="-s -w" -o "$OUT/apk/lib/arm64-v8a/libskiffd.so" .)

echo "==> resources"
aapt package -f -M android/AndroidManifest.xml -S android/res -I "$ANDROID_JAR" -F "$OUT/base.apk" -J "$OUT/gen"

echo "==> java"
javac -nowarn -source 8 -target 8 -bootclasspath "$ANDROID_JAR" -cp "$ANDROID_JAR" -d "$OUT/classes" \
  $(find android/src "$OUT/gen" -name '*.java') 2>&1 | grep -v -E "^warning|bootstrap classpath|^1 warning|source value 8|target value 8|To suppress warnings" || true
"$BT/dx" --dex --min-sdk-version=26 --output="$OUT/apk/classes.dex" "$OUT/classes"

echo "==> package"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT/apk" && aapt add "$OUT/unsigned.apk" classes.dex lib/arm64-v8a/libskiffd.so >/dev/null)
zipalign -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  PASS=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$PASS" -keypass "$PASS" -alias skiff \
    -keyalg RSA -keysize 3072 -validity 10000 -dname "CN=Skiff, O=Navree" >/dev/null 2>&1
  echo "$PASS" > "$KEYSTORE.pass"
  chmod 600 "$KEYSTORE" "$KEYSTORE.pass"
fi
apksigner sign --ks "$KEYSTORE" --ks-pass "file:$KEYSTORE.pass" --ks-key-alias skiff --out "$OUT/skiff.apk" "$OUT/aligned.apk"
apksigner verify "$OUT/skiff.apk"

ls -la "$OUT/skiff.apk"
