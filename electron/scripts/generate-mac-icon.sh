#!/bin/sh

cd ./assets/

mkdir pdv-icon.iconset

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "Error: rsvg-convert is not installed."
  echo "Please install it (e.g., 'brew install librsvg' on macOS) and try again."
  exit 1
fi

rsvg-convert -w 16  -h 16  pdv-icon-mac.svg -o pdv-icon.iconset/icon_16x16.png
rsvg-convert -w 32  -h 32  pdv-icon-mac.svg -o pdv-icon.iconset/icon_16x16@2x.png
rsvg-convert -w 32  -h 32  pdv-icon-mac.svg -o pdv-icon.iconset/icon_32x32.png
rsvg-convert -w 64  -h 64  pdv-icon-mac.svg -o pdv-icon.iconset/icon_32x32@2x.png
rsvg-convert -w 128 -h 128 pdv-icon-mac.svg -o pdv-icon.iconset/icon_128x128.png
rsvg-convert -w 256 -h 256 pdv-icon-mac.svg -o pdv-icon.iconset/icon_128x128@2x.png
rsvg-convert -w 256 -h 256 pdv-icon-mac.svg -o pdv-icon.iconset/icon_256x256.png
rsvg-convert -w 512 -h 512 pdv-icon-mac.svg -o pdv-icon.iconset/icon_256x256@2x.png
rsvg-convert -w 512 -h 512 pdv-icon-mac.svg -o pdv-icon.iconset/icon_512x512.png
rsvg-convert -w 1024 -h 1024 pdv-icon-mac.svg -o pdv-icon.iconset/icon_512x512@2x.png

if ! command -v iconutil >/dev/null 2>&1 && ! command -v png2icns >/dev/null 2>&1; then
  echo "Error: Neither iconutil nor png2icns is installed."
  echo "On macOS, iconutil should be available by default."
  echo "On Linux, you can install a compatible tool with: 'sudo apt install icnsutils'"
  exit 1
fi


# Try to generate the .icns file using iconutil (macOS), fallback to png2icns (Linux)
if iconutil -c icns pdv-icon.iconset; then
  echo "ICNS file generated with iconutil."
else
  if command -v png2icns >/dev/null 2>&1; then
    echo "iconutil failed, trying png2icns (Linux)..."
    cd pdv-icon.iconset
    png2icns ../pdv-icon.icns icon_*.png
    cd ..
    echo "ICNS file generated with png2icns."
  else
    echo "Error: Could not generate .icns file. Neither iconutil nor png2icns succeeded."
    exit 1
  fi
fi
