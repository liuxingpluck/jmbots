#!/usr/bin/env bash
# memorycli 测速：全量摄取、没变再摄取、改一个文件再摄取、搜索、查图，每项跑 3 次，打印毫秒。
# 只读被测目录（改文件那一项在临时复制出来的目录里做），索引写在临时目录，跑完删掉。
#
# 用法（在 jmbots 根目录）：
#   cd memorycli && cargo build --release && cd ..
#   bash memorycli/bench/speed.sh [被测目录，默认当前目录] [搜索词，默认 handleMessage]
set -euo pipefail

JM="$(cd "$(dirname "$0")/.." && pwd)/target/release/memorycli"
ROOT="$(cd "${1:-.}" && pwd)"
QUERY="${2:-handleMessage}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 跑一条命令，打印用时（毫秒）。
ms() {
  local start
  start=$(date +%s%N)
  "$@" >/dev/null 2>&1
  echo -n "$(( ($(date +%s%N) - start) / 1000000 )) "
}

echo "被测目录：$ROOT"
echo -n "全量摄取（ms）："
for _ in 1 2 3; do rm -f "$TMP"/a.db*; ms "$JM" ingest --no-ai --root "$ROOT" --db "$TMP/a.db"; done; echo
echo -n "没变再摄取（ms）："
for _ in 1 2 3; do ms "$JM" ingest --no-ai --root "$ROOT" --db "$TMP/a.db"; done; echo

#M 改一个文件：复制一份再改，不动原目录。
mkdir -p "$TMP/copy"
tar -C "$ROOT" --exclude=node_modules --exclude=target --exclude=.git --exclude=.memorycli --exclude=dist -cf - . | tar -C "$TMP/copy" -xf -
"$JM" ingest --no-ai --root "$TMP/copy" --db "$TMP/b.db" >/dev/null 2>&1
TARGET="$(find "$TMP/copy" -type f \( -name '*.ts' -o -name '*.rs' -o -name '*.go' -o -name '*.py' \) -print -quit)"
echo -n "改一个文件再摄取（ms）："
for i in 1 2 3; do echo "// speed $i" >> "$TARGET"; ms "$JM" ingest --no-ai --root "$TMP/copy" --db "$TMP/b.db"; done; echo

echo -n "search $QUERY（ms，含启动进程）："
for _ in 1 2 3; do ms "$JM" search "$QUERY" --root "$ROOT" --db "$TMP/a.db"; done; echo
echo -n "graph $QUERY（ms，含启动进程）："
for _ in 1 2 3; do ms "$JM" graph "$QUERY" --root "$ROOT" --db "$TMP/a.db"; done; echo
"$JM" ingest --no-ai --root "$ROOT" --db "$TMP/a.db" 2>/dev/null | grep -A6 '"totals"'
