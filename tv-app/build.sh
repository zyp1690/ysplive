#!/usr/bin/env bash
# 构建 ysplive TV 的 APK：aapt2 → javac(或 ECJ) → d8 → zipalign → apksigner
# 依赖：bash / curl / unzip / zip / java。首次运行会下载 Android build-tools 与 platform（约 120MB）。
set -euo pipefail
cd "$(dirname "$0")"

BT_URL="https://dl.google.com/android/repository/build-tools_r33.0.2-linux.zip"
PLATFORM_URL="https://dl.google.com/android/repository/platform-32_r01.zip"
SDK_DIR=".sdk"
BT_DIR="$SDK_DIR/android-13"          # build-tools 33.0.2 解包目录
ANDROID_JAR="$SDK_DIR/android-12/android.jar"   # platform-32 解包目录

APP="app/src/main"
BUILD="build"
VERSION_NAME="1.0.0"
VERSION_CODE="1"
OUT="ysplive-tv-v${VERSION_NAME}.apk"

if [ ! -x "$BT_DIR/aapt2" ]; then
    echo "[1/6] 下载 Android build-tools 33.0.2 ..."
    mkdir -p "$SDK_DIR"
    curl -fsSL -o "$SDK_DIR/bt.zip" "$BT_URL"
    unzip -q -o "$SDK_DIR/bt.zip" -d "$SDK_DIR"
fi
if [ ! -f "$ANDROID_JAR" ]; then
    echo "[1/6] 下载 Android platform 32 ..."
    curl -fsSL -o "$SDK_DIR/plat.zip" "$PLATFORM_URL"
    unzip -q -o "$SDK_DIR/plat.zip" -d "$SDK_DIR"
fi

AAPT2="$BT_DIR/aapt2"
D8="$BT_DIR/d8"
ZIPALIGN="$BT_DIR/zipalign"
APKSIGNER="$BT_DIR/apksigner"

rm -rf "$BUILD"
mkdir -p "$BUILD/gen" "$BUILD/classes" "$BUILD/dex"

echo "[2/6] aapt2 compile 资源 ..."
"$AAPT2" compile --dir "$APP/res" -o "$BUILD/res.zip"

echo "[3/6] aapt2 link 生成未签名包与 R.java ..."
"$AAPT2" link \
    -o "$BUILD/base.apk" \
    -I "$ANDROID_JAR" \
    --manifest "$APP/AndroidManifest.xml" \
    -R "$BUILD/res.zip" \
    --java "$BUILD/gen" \
    --auto-add-overlay \
    --min-sdk-version 14 \
    --target-sdk-version 28 \
    --version-code "$VERSION_CODE" \
    --version-name "$VERSION_NAME"

echo "[4/6] 编译 Java ..."
SRC=$(find "$APP/java" "$BUILD/gen" -name '*.java')
if command -v javac >/dev/null 2>&1; then
    javac -nowarn -source 8 -target 8 \
        -bootclasspath "$ANDROID_JAR" \
        -classpath "$ANDROID_JAR" \
        -d "$BUILD/classes" $SRC
else
    echo "    没有 javac，改用 ECJ 编译器"
    curl -fsSL -o "$BUILD/ecj.jar" \
        "https://repo1.maven.org/maven2/org/eclipse/jdt/ecj/3.33.0/ecj-3.33.0.jar"
    java -jar "$BUILD/ecj.jar" -source 8 -target 8 \
        -bootclasspath "$ANDROID_JAR" -d "$BUILD/classes" $SRC
fi

echo "[5/6] d8 生成 dex 并打包 ..."
"$D8" --min-api 14 --lib "$ANDROID_JAR" --output "$BUILD/dex" \
    $(find "$BUILD/classes" -name '*.class')
cp "$BUILD/base.apk" "$BUILD/unaligned.apk"
(cd "$BUILD/dex" && zip -q -r "../unaligned.apk" classes.dex)
"$ZIPALIGN" -p -f 4 "$BUILD/unaligned.apk" "$BUILD/aligned.apk"

echo "[6/6] 签名 ..."
if [ ! -f ".keystore.jks" ]; then
    echo "    生成构建用的签名（每个构建机独立，覆盖升级需先卸载）"
    keytool -genkeypair -keystore ".keystore.jks" -alias ysplive \
        -storepass ysplive -keypass ysplive -keyalg RSA -keysize 2048 \
        -validity 10000 -dname "CN=ysplive TV, OU=huowu, O=huowu, C=CN" >/dev/null 2>&1
fi
"$APKSIGNER" sign \
    --ks ".keystore.jks" --ks-pass pass:ysplive --key-pass pass:ysplive \
    --min-sdk-version 14 \
    --out "$OUT" "$BUILD/aligned.apk"

echo
echo "完成：$(pwd)/$OUT  ($(stat -c%s "$OUT" 2>/dev/null || wc -c < "$OUT") 字节)"
sha256sum "$OUT" 2>/dev/null || true
