#!/usr/bin/env bash
# Compile PDV.icon into Assets.car using actool (requires Xcode).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ICON_PATH="$SCRIPT_DIR/../assets/pdv-macicon.icon"
OUTPUT_PATH="$SCRIPT_DIR/../assets"
PLIST_PATH="$OUTPUT_PATH/assetcatalog_generated_info.plist"

if [ ! -e "$ICON_PATH" ]; then
    echo "Error: $ICON_PATH not found. Create it with Icon Composer first." >&2
    exit 1
fi

if ! command -v actool &>/dev/null; then
    echo "Error: actool not found. Install Xcode and run: xcode-select --install" >&2
    exit 1
fi

echo "Compiling $ICON_PATH → $OUTPUT_PATH/Assets.car"

actool "$ICON_PATH" --compile "$OUTPUT_PATH" \
    --output-format human-readable-text --notices --warnings --errors \
    --output-partial-info-plist "$PLIST_PATH" \
    --app-icon Icon --include-all-app-icons \
    --enable-on-demand-resources NO \
    --development-region en \
    --target-device mac \
    --minimum-deployment-target 26.0 \
    --platform macosx

rm -f "$PLIST_PATH"
echo "Assets.car created at $OUTPUT_PATH/Assets.car"
