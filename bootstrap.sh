#!/bin/sh
# [INPUT]: RECUT_MODELS_DIR supplied by the platform Python runtime
# [OUTPUT]: prepares the official CosyVoice repository (with its vendored
#           Matcha-TTS submodule) in the shared model namespace
# [POS]: permissive App fallback setup; the platform owns venv and pip lifecycle
# [PROTOCOL]: 变更时更新此头部，然后检查 README.md
set -eu

AUDIO_ROOT="$RECUT_MODELS_DIR/audio-studio"
REPOSITORY="$AUDIO_ROOT/cosyvoice/repository"
mkdir -p "$REPOSITORY"

if [ ! -d "$REPOSITORY/.git" ]; then
  rm -rf "$REPOSITORY"
  # --recursive pulls third_party/Matcha-TTS, required by the CosyVoice flow/hifigan modules.
  git clone --depth 1 --recursive https://github.com/FunAudioLLM/CosyVoice.git "$REPOSITORY"
elif [ ! -d "$REPOSITORY/third_party/Matcha-TTS/matcha" ]; then
  git -C "$REPOSITORY" submodule update --init --recursive --depth 1
fi
