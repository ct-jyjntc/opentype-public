#!/usr/bin/env bash
# 编译四个原生 helper 为 dylib，供 Node 侧 koffi 以 C ABI 加载。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE="$ROOT/native"
ARCH="$(uname -m)"

build_one() {
  local name="$1"
  local src="$2"
  local out="$NATIVE/$name/build/lib$3.dylib"
  local sources=("$src")
  if [[ "$name" == "input-helper" ]]; then
    sources+=("$NATIVE/input-helper/PasteboardRestorer.swift" "$NATIVE/input-helper/InputTarget.swift")
  fi
  mkdir -p "$(dirname "$out")"

  # -emit-library 产出 dylib；@_cdecl 保证导出符号是 C 风格名字，koffi 才能找到。
  swiftc -emit-library -O -whole-module-optimization \
    -module-name "${name//-/}" \
    -target "$ARCH-apple-macosx13.0" \
    -framework AppKit -framework AVFoundation -framework ApplicationServices -framework IOKit \
    -o "$out" "${sources[@]}"

  echo "  built -> $out"
}

echo "building native helpers ($ARCH)"
build_one "input-helper"    "$NATIVE/input-helper/InputHelper.swift"       "InputHelper"
build_one "keyboard-helper" "$NATIVE/keyboard-helper/KeyboardHelper.swift" "KeyboardHelper"
build_one "context-helper"  "$NATIVE/context-helper/ContextHelper.swift"   "ContextHelper"
build_one "util-helper"     "$NATIVE/util-helper/UtilHelper.swift"         "UtilHelper"

mkdir -p "$NATIVE/output-audio/build"
swiftc -O -target "$ARCH-apple-macosx13.0" -framework CoreAudio \
  "$NATIVE/output-audio/OutputAudio.swift" -o "$NATIVE/output-audio/build/OutputAudio"

mkdir -p "$NATIVE/apple-speech/build"
swiftc -parse-as-library -O -target "$ARCH-apple-macosx13.0" -framework Speech -framework AVFoundation \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$NATIVE/apple-speech/Info.plist" \
  "$NATIVE/apple-speech/AppleSpeech.swift" -o "$NATIVE/apple-speech/build/AppleSpeech"

echo "done"
