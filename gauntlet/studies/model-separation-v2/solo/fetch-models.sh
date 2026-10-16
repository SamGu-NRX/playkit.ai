#!/bin/bash
# Download the three Qwen2.5-Instruct GGUFs and verify against the study manifest.
set -uo pipefail
M=/home/user/work/gauntlet-models
mkdir -p "$M"
declare -A URLS=(
  [qwen2.5-0.5b-instruct-q4_k_m.gguf]="https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf"
  [qwen2.5-1.5b-instruct-q4_k_m.gguf]="https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"
  [qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf]="https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf"
  [qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf]="https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf"
)
for F in qwen2.5-0.5b-instruct-q4_k_m.gguf qwen2.5-1.5b-instruct-q4_k_m.gguf qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf; do
  echo "=== download $F"
  curl -sL --fail -o "$M/$F" "${URLS[$F]}" || { echo "DOWNLOAD-FAILED $F"; exit 1; }
  echo "=== got $F $(stat -c%s "$M/$F") bytes"
done
sha256sum -c /home/user/work/burst12-playkit-separation-v2-solo/gauntlet/studies/model-separation/models.sha256 \
  && echo ALL-SHAS-OK || { echo SHA-MISMATCH; exit 1; }
