#!/usr/bin/env bash
# End-to-end driver: create a session on the fake provider, send long prompts,
# and let the memory pipeline fire. Run while the dev server is up.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE=http://127.0.0.1:3099
TOKEN="$1"
curl -s -c .dev/jar.txt -L "$BASE/?token=$TOKEN" -o /dev/null

rpc() {
  local endpoint="$1" payload="$2" id="$3"
  curl -s -b .dev/jar.txt -X POST "$BASE/api/$endpoint" -H 'content-type: application/json' \
    -d '{"type":"client-request","rpcId":"'$id'","method":"'$endpoint'","payload":{"args":{"request":'"$payload"'}}}'
}

mkdir -p /tmp/om-e2e-cwd 2>/dev/null || mkdir -p .dev/e2e-cwd
CWD="$PWD/.dev/e2e-cwd"
mkdir -p "$CWD"

echo '== create session'
rpc session/create '{"cwd":"'"$CWD"'","agentPreset":"standard"}' c1 | tee .dev/create.json
echo
SESSION=$(python3 -c "import json; print(json.load(open('.dev/create.json'))['result']['value']['sessionId'])")
echo "session: $SESSION"

LONG=$(python3 -c "print('Please remember: the project codename is NARWHAL. ' + 'Details about the migration plan, the schema design, and the rollout order. ' * 8)")
for i in 1 2 3; do
  echo "== prompt $i"
  rpc session/prompt '{"requestId":"req-'$i'","sessionId":"'$SESSION'","mode":"queue","content":[{"type":"text","text":"'"$LONG"'"}]}' p$i | head -c 200
  echo
  sleep 3
done

echo '== wait for workers'
sleep 12

echo '== ledger'
ls .dev/dsh-home/observational-memory/ 2>/dev/null || echo 'no ledger dir'
cat ".dev/dsh-home/observational-memory/$SESSION.jsonl" 2>/dev/null | python3 -c "
import json, sys
for line in sys.stdin:
    entry = json.loads(line)
    kind = entry.get('kind')
    if kind == 'observations-recorded':
        print('observations:', len(entry['observations']), 'coversUpToSeq:', entry['coversUpToSeq'])
    elif kind == 'reflections-recorded':
        print('reflections:', [r['content'][:60] for r in entry['reflections']])
    elif kind == 'observations-dropped':
        print('dropped:', entry['observationIds'])
    elif kind == 'visible-memory':
        print('visible-memory: fullFold=%s upToSeq=%s text=%d chars' % (entry['fullFold'], entry['upToSeq'], len(entry['text'])))
" || echo 'no ledger file'
