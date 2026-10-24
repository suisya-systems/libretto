#!/usr/bin/env bash
# 画面の状態ごとに、1440 と 390、ライトとダークで撮る（手順と理由は SKILL.md）
# bash .claude/skills/shoot/shoot.sh [--check] [state...]   state を省くと states.ts の全部
#   --check  Chrome を使わず、状態ごとのプレビューがその状態に着いて応答するかだけ確かめる（sandbox の中で通る）
# 環境変数: SHOOT_OUT（出力先。既定 <repo>/.worker-scratch/shots）/ SHOOT_PORT（既定 7930。状態ごとに +1）
#           SHOOT_PREFIX（ファイル名の頭）/ CHROME（Windows の chrome.exe）
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
CHECK=0
[ "${1:-}" = --check ] && { CHECK=1; shift; }
PREVIEW=(node --experimental-strip-types --no-warnings "$HERE/preview.ts")
if [ $# -gt 0 ]; then STATES=("$@"); else mapfile -t STATES < <("${PREVIEW[@]}" --list); fi
# 390 の 1 画面目が他と同じでよい状態（states.ts の sameFirst390）。重複の検査から外す
mapfile -t SAME390 < <("${PREVIEW[@]}" --same-first-390)
OUT="${SHOOT_OUT:-$ROOT/.worker-scratch/shots}"
PORT="${SHOOT_PORT:-7930}"
PREFIX="${SHOOT_PREFIX:-}"
CHROME="${CHROME:-/mnt/c/Program Files/Google/Chrome/Application/chrome.exe}"
mkdir -p "$OUT" || exit 1
if [ $CHECK = 0 ]; then
  [ -x "$CHROME" ] || { echo "chrome not found: $CHROME (set CHROME)"; exit 1; }
  UNC="$(wslpath -w "$OUT")" || { echo "wslpath failed: run on WSL"; exit 1; }
fi
npm run --prefix "$ROOT" build >/dev/null 2>&1 || { echo "build failed"; exit 1; }

SRV=
trap '[ -n "$SRV" ] && kill $SRV 2>/dev/null' EXIT
FAIL=0
FIRST=1
size() { stat -c %s "$OUT/$1" 2>/dev/null || echo 0; }

# --virtual-time-budget は使わない（画面が SSE をつなぎっぱなしにして通信が止まないので戻らない）。
# --timeout は待つ上限。プレビューの /hold が 15 秒で返るので、それより長くする
chrome() { # chrome <file> <scheme 0=dark|1=light> <window w> <window h> <url>
  rm -f "$OUT/$1"
  timeout 60 "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --blink-settings=preferredColorScheme=$2 --window-size=$3,$4 \
    --timeout=20000 --screenshot="$UNC\\$1" "$5" </dev/null >/dev/null 2>&1
}

# shot <name> <scheme> <frame w> <frame h> <full 0|1>。full は全体を撮る 1 枚（frame h は最初の見込み）
shot() {
  local name=$1 scheme=$2 fw=$3 fh=$4 full=$5
  # Windows の Chrome は窓を約 500px より狭くできない。狭い幅は広い窓で撮って左上を切り出す
  local ww=$fw file="$name.png"
  [ "$fw" -lt 520 ] && { ww=520; file="$name.raw.png"; }
  for t in 1 2 3; do
    local id="$name-$t-$RANDOM"
    chrome "$file" "$scheme" "$ww" "$fh" "http://127.0.0.1:$P/frame?w=$fw&h=$fh&id=$id"
    local b line
    b=$(size "$file")
    line=$(grep "^READY $id " "$LOG" | tail -1)
    # PNG が無い・この 1 枚の READY が無い、は撮り直す。READY は frame のページが届いて印が描けたときだけ出るので、
    # 接続拒否の画面や描画前の 1 枚はここで弾ける。大きさのしきい値は使わない（正しく撮れた 390 の 1 画面目でも 40KB を切る）
    if [ "$b" -gt 0 ] && [ -n "$line" ]; then
      local h=${line#*h=}
      h=${h%% *}
      # 全体を撮る 1 枚で中身が枠より長ければ、中身の高さで撮り直す
      if [ "$full" = 1 ] && [ "$h" -gt "$fh" ]; then
        echo "grow $name to ${h}px"
        fh=$h
        continue
      fi
      [ "${line##*dark=}" = $((1 - scheme)) ] || { echo "scheme not applied: $name ($line)"; FAIL=1; }
      if [ "$file" != "$name.png" ]; then
        node "$HERE/png-crop.mjs" "$OUT/$file" "$OUT/$name.png" "$fw" "$fh" && rm -f "$OUT/$file" ||
          { echo "crop failed: $name (raw kept)"; FAIL=1; }
      fi
      echo "ok $name"
      return 0
    fi
    echo "retry $name ($b bytes, $(grep -E "^(READY|TIMEOUT) $id( |$)" "$LOG" || echo 'no READY'))"
  done
  echo "gave up: $name"
  FAIL=1
}

P=$PORT
for S in "${STATES[@]}"; do
  P=$((P + 1))
  LOG="$OUT/preview-$S.log"
  # 前の回の残ったプレビューが同じポートで応答していたら止める（別の状態を撮ってしまう）
  if curl -fsS -o /dev/null "http://127.0.0.1:$P/state" 2>/dev/null; then echo "port $P is in use: stop"; exit 1; fi
  "${PREVIEW[@]}" "$S" "$P" >"$LOG" 2>&1 &
  SRV=$!
  GOT=
  for _ in $(seq 1 120); do
    GOT=$(curl -fsS "http://127.0.0.1:$P/state" 2>/dev/null) && break
    kill -0 $SRV 2>/dev/null || break
    sleep 0.5
  done
  if [ "$GOT" != "$S" ]; then
    echo "preview $S not serving on $P (got '$GOT'): stop"
    grep -v '^\(GET\|POST\) ' "$LOG" | tail -5
    exit 1
  fi
  grep "^preview $S " "$LOG"
  if [ $CHECK = 1 ]; then
    kill $SRV
    wait $SRV 2>/dev/null
    SRV=
    continue
  fi
  # 起こした直後の 1 枚目は WSL2 の localhost の転送が張られる前で接続拒否になる（捨て撮り）
  chrome warmup.png 1 800 600 "http://127.0.0.1:$P/state"
  # 1 枚目で PNG が 1 バイトも書かれなければ、何度撮っても同じ（sandbox の中で流した等）。全体を止める
  [ $FIRST = 1 ] && [ "$(size warmup.png)" = 0 ] && { echo "first shot wrote no png (run outside the sandbox): stop"; exit 1; }
  FIRST=0
  rm -f "$OUT/warmup.png"
  for M in 1 0; do
    L=$([ $M = 1 ] && echo light || echo dark)
    shot "$PREFIX$S-1440-$L" $M 1440 2200 1
    shot "$PREFIX$S-390-$L" $M 390 844 0
    shot "$PREFIX$S-390full-$L" $M 390 4100 1
  done
  kill $SRV
  wait $SRV 2>/dev/null
  SRV=
done
[ $CHECK = 1 ] && { echo "check ok: ${STATES[*]}"; exit 0; }

# 同じ幅・同じ明暗で状態の違う PNG が同じ中身なら、別の状態を撮れていない。ライトとダークが同じなら明暗が効いていない
for K in 1440 390 390full; do
  for L in light dark; do
    D=$(for S in "${STATES[@]}"; do
      [ "$K" = 390 ] && printf '%s\n' "${SAME390[@]}" | grep -qxF "$S" && continue
      md5sum "$OUT/$PREFIX$S-$K-$L.png" 2>/dev/null
    done | awk '{print $1}' | sort | uniq -d)
    [ -n "$D" ] && { echo "duplicate across states: $K-$L"; FAIL=1; }
  done
  for S in "${STATES[@]}"; do
    A=$(md5sum <"$OUT/$PREFIX$S-$K-light.png" 2>/dev/null)
    [ -n "$A" ] && [ "$A" = "$(md5sum <"$OUT/$PREFIX$S-$K-dark.png" 2>/dev/null)" ] && { echo "light = dark: $S-$K"; FAIL=1; }
  done
done
ls -l "$OUT"/*.png
[ $FAIL = 0 ] && echo "all shots ok" || { echo "some shots failed (see above)"; exit 1; }
