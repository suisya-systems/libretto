# 隔離の確認（linux・2026-10-24）

- OS: linux 6.18.54.1-microsoft-standard-WSL2（x64）
- Node: v22.17.0
- claude: 2.1.310
- 隔離の水準: strong
- 流したもの: `host/scripts/sandbox-live.ts --model --probe --record`
- 結果: 30/30 passed

| 確かめたこと | 結果 | 補足 |
|---|---|---|
| claude version >= minimum | PASS | 2.1.310 |
| isolation strong | PASS |  |
| shell: work readable | PASS |  |
| shell: versions not readable | PASS | versions: cat: <LIBRETTO_HOME>/cases/c1/versions/01/draft-01.md: No such file or directory |
| shell: checks not readable | PASS | checks: cat: <LIBRETTO_HOME>/cases/c1/checks/checks.json: No such file or directory |
| shell: review not readable | PASS | review: cat: <LIBRETTO_HOME>/cases/c1/review-01-a.json: No such file or directory |
| shell: facts not readable | PASS | facts: cat: <LIBRETTO_HOME>/cases/c1/facts.json: No such file or directory |
| shell: jobs not readable | PASS | jobs: cat: <LIBRETTO_HOME>/cases/c1/jobs/作り手-1.json: No such file or directory |
| shell: otherCase not readable | PASS | otherCase: cat: <LIBRETTO_HOME>/cases/c2/work/brief.md: No such file or directory |
| shell: db not readable | PASS | db: cat: <LIBRETTO_HOME>/libretto.db: No such file or directory |
| shell: apiKeys not readable | PASS | apiKeys: cat: <LIBRETTO_HOME>/api-keys.json: No such file or directory |
| shell: env not readable | PASS | env: cat: <LIBRETTO_HOME>/.env.local: No such file or directory |
| shell: write inside work | PASS |  |
| shell: write outside work does not reach the host | PASS | writeOutside: ok |
| shell: versions unchanged on the host | PASS | writeVersions: ng |
| shell: home shows only allowed entries | PASS | home: .claude .local work  |
| shell: ~/.claude shows only credentials | PASS | claudeDir: .credentials.json  |
| crash: sandboxed child started | PASS |  |
| crash: no child left after host SIGKILL | PASS | beat 1 -> 1 |
| model+srt: work readable | PASS |  |
| model+srt: checks/versions/api-keys not readable | PASS |  |
| model+rules: work readable | PASS |  |
| model+rules: checks/versions/api-keys not readable | PASS |  |
| model control: checks readable without rules | PASS |  |
| probe: session ended normally | PASS |  |
| probe: reached the work folder | PASS |  |
| probe: checks token not visible | PASS |  |
| probe: home shows only allowed entries | PASS |  |
| probe: control sees the token (detection works) | PASS |  |
| probe: verdict hidden | PASS | hidden |
