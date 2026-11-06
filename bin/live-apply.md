# liveなDSHへの反映

Coreのbuild、`~/.dsh` のprofileとpatch、skillのリンク、このリポジトリの主checkoutの一部は、すべてliveである。`PATH` の `dsh` は `/data/softwares/deepseek-harness/apps/cli/lib/bin.js` を指す。どのプロジェクトのworker（kstackの `run-worker.sh`）もこれを動かす。liveへの変更は一つずつ反映する。前後の状態をprobeで確かめ、失敗したら元に戻す（[#48](https://github.com/kkiyama117/deepseek-harness-plugins/issues/48)）。起動先の検査は[配置検査](runtime-placement.md)が受け持つ。Core差分の検査は[管理区分](../SOURCE-OWNERSHIP.md)が受け持つ。

この文書は反映経路の仕組みを説明する。現在導入されている版や観測の記録は配置の一覧にあたる。そのためGitには含めず、`reports/agents/` に置く。

## liveを読むもの

| 読み手 | 起動 | profile | いつ読み直すか |
|---|---|---|---|
| worker・reviewer（`run-worker.sh`） | 実行ごとに `dsh headless --patch <一時patch> ...` | `headless` | 次の実行。常に最新を読む |
| `slack-intake-bridge.service`（本番） | 常駐。`--profile headless --patch configs/dsh-slack-worker-config/daemon.patch.yml` | `headless` | serviceの再起動。`Restart=on-failure` なので、落ちて自動で再起動したときにも読む |
| `ai-reference-store-daily.service`（本番） | timerで毎日1回。`daily-start.sh` 経由 | `ai-reference-store-daily` | 次のtimer起動 |
| `dsh-web-managed.service` | 常駐。`dsh web` | `web` | serviceの再起動（client bundleは下の注を参照） |

1回の起動では、設定を次の順序で重ねて適用する（`apps/cli/src/profile-boot.ts`）。まずprofileの `package.json` にある `dsh.profile.bundles` の順に各bundleのpatchを適用し、次にprofileの `cordis.patch.yml`、homeの `~/.dsh/cordis.patch.yml`、最後に `--patch` を重ねる。どの起動でもprofileの `cordis.yml` は空の内容で上書きされる。そのため `--dump-config` を含むすべての `dsh` の起動は、`~/.dsh` への書き込み操作となる。Coreに同梱されたテンプレート名（`headless`、`web` など）のprofileが存在しないまま起動すると、そのprofileが自動作成される（`loadProfile`）。それ以外の名前では作成されずに失敗する。反映のscriptとprobeは、`dsh` を呼ぶ前に該当profileの `package.json` の存在を確認する。ファイルがなければ `dsh` を起動しない。scriptが扱う対象は、`package.json` があるprofileのpatchに限られる。

`headless` profileはworkerと本番の両方が使う。`headless` に届く変更は、次のworker実行にすぐ届く。本番にはbridgeの次の再起動で届く。本番への反映は、人が再起動しなくてもbridgeが落ちれば起きる。

## 反映の経路

本番に届く反映には、所有者の承認が要る。「本番」とは、その経路が `headless` や `ai-reference-store-daily` のprofile、あるいは本番のserviceに届くことを表す。中身が同一で何も変更しない実行には、承認を必要としない。反映のscriptは、本番対象外と定めたprofile（現在は `web` のみ）の一覧を持つ。一覧にないprofileは、すべて本番として扱う。

| 経路 | 何が変わるか | 届く先と時期 | 戻し方 | 本番 |
|---|---|---|---|---|
| A. Coreのbuild（Coreで `pnpm build`） | `apps/*/lib`・`packages/*/lib` の全部。Gitの管理外 | 全profile。workerは次の実行、常駐serviceは再起動、dailyは次の起動 | build前に全 `lib/` の写し（tar）を取り、戻すときはそれを展開する。Gitからは戻せない | 届く |
| B. Coreのcheckoutの更新（upstreamのmerge） | ソースと、bundleのpatch（`packages/bundle/*/cordis.patch.yml` などのyml） | bundleのymlはbuildなしで次の起動に届く。コードはAのbuildまで届かない | 前のcommitに戻し、Aを戻す。Coreの作業ツリーと未コミットの変更は所有者のもの | 届く |
| C. profileへのbundleの追加・更新（`dsh plugin --profile <p> add ...`。profileの中でpnpmを動かす） | profileの `package.json`、`pnpm-lock.yaml`、`node_modules` | そのprofileの次の起動 | 3ファイルと `node_modules` の写しから戻す。`file:` のtarballは導入時に `node_modules` へ展開されるため、`releases/` のtarballを上書きしても再導入まで届かない。戻すには前の版のtarballを残しておく | `web` 以外のprofileなら届く。`web` でも、homeのpatchが読むプラグインなら届く（下の「経路をまたぐつながり」） |
| D. `link:` の依存 | リンク先のディレクトリの中身 | そのprofileの次の起動。導入もbuildも要らない（`.mjs` のプラグイン）。Coreへの `link:` はA・Bに従う | リンク先を前の内容に戻す | リンク先とprofileによる |
| E. profileのpatch（`~/.dsh/profiles/<p>/cordis.patch.yml`。`desktop` はElectronのアプリだけが扱うので対象外） | そのprofileの行の上書き | そのprofileの次の起動 | 前のファイルの写しを戻す | `web` 以外のprofileなら届く（一覧にないprofileは本番として扱う） |
| F. homeのpatch（`~/.dsh/cordis.patch.yml`） | 全profileの行。sessionとstorageの保存先（[#45](https://github.com/kkiyama117/deepseek-harness-plugins/issues/45)）を含む | 全profileの次の起動 | 前のファイルの写しを戻す | 届く |
| G. このcheckoutのdaemon patch（`configs/dsh-slack-worker-config/daemon.patch.yml`） | 本番bridgeの行 | bridgeの次の再起動だけ | 前の内容に戻し、bridgeを再起動する | 届く |
| H. このリポジトリの主checkoutの更新（`git pull` など） | DとGのリンク先 | `web` が `link:` で読むプラグイン（`plugins/llm-fallback`、`configs/*-mcp*` など）と、bridgeが読むdaemon patch。PRのmergeだけではliveは変わらず、主checkoutを更新したときに変わる | 前のcommitの内容に戻す | `configs/dsh-slack-worker-config/` が変われば届く |
| I. `~/.dsh/skills` のリンク | DSHが見つけるskill | 次の起動（起動中の再走査は未確認）。リンク先がkstackのcheckoutなら、kstackの変更がそのまま届く | リンクかリンク先を戻す | skillを使う起動に届く |
| J. `run-worker.sh` の一時patch | workerのmodelの経路と認証情報の有効化 | worker・reviewerの次の実行だけ | kstackの所有者が戻す | 届かない |

壊れたliveの修理は、反映のscriptの外で手動で行う。liveのpatchが壊れていると、前の確認（`--dump-config`）が失敗してscriptでは直せないためである。修理には manager の go が必要である。本番に届くものは所有者の承認も要る。

主checkoutの更新（H）は、すべてliveへの反映として扱う。前後にprobeを流し、manager の go を得てから行う。`configs/dsh-slack-worker-config/` が変わる更新は本番への反映にあたる。この更新には所有者の承認が要る。

経路をまたぐつながり:

- `web` profileの依存の更新（C）は、`headless` のworkerや本番にも届くことがある。homeのpatch（F）が `web` profileの `node_modules` の中のプラグインを `insert` する場合があるためである。Cを `web` だけの変更と見なしてはならない。
- Cの前に、`package.json` にないリンクの一覧を写しに含める。`web` profileの `node_modules` に、`package.json` に書かれていないリンクが存在することがあるためである。bundleにもpatchにもなければ読み込まれないが、そのprofileでpnpmを動かすと消えることがある（未確認）。
- Aのあと、hostを再起動しなくても開いた画面の再読込でclientだけ新しくなることがある（未確認）。Webのclient bundleが `lib/` から配られるためである。
- Aは実行中のworkerがないときに行う。Aの最中は `lib/` が書きかけになるためである。そのあいだに起動したworkerや、落ちて再起動したserviceは壊れたbuildを読む。

Nodeとsystemdのunitは、このリポジトリの反映の手順には含めない。これらもliveであるが、本手順の対象外とする。なお、serviceのunitはmiseの `latest` を指す。

## probe

反映の前と後に、既定のworkerの経路で一行のprobeを流す。

```sh
d=$(mktemp -d)
printf 'What is 17*23? Reply with only the number.' |
  /data/softwares/kstack/skills/kiyama-mode/scripts/run-worker.sh --read-only "$d" dsh ollama-cloud deepseek-v4.1-flash high
```

probeの成功は、3つの条件がそろうことである。exit 0で終わること、標準出力を空白で整えたものがちょうど `391` であること、`$d` が空のままであることの3点である。second reviewerの経路（`dsh openai-codex gpt-6.1-sol high`）も同じprobeを流す。この経路はprofileの `credentials` 行と保存済みのproviderのloginを通る。そのため、workerの経路では見えない壊れ方を見つける。

providerの一時的な失敗（`PI_AI_ERROR` の過負荷など）は、反映が壊したことと区別できない。後のprobeと、戻したあとのprobeが失敗したら、30秒あけて一度だけ流し直す。二度とも失敗したら失敗とする。前の確認（`--dump-config` とprobe）が失敗したら、対象を変えずに止まる。

probeはsessionを一つ作る。保存先はhomeのpatch（F）が決める。

## 反映のscript

`bin/live-apply.py` は、経路EとF（profileのpatchとhomeのpatch）を一つずつ反映する。ほかの経路はまだ扱わない。liveに向けて流すのは manager の go のあとだけである。本番に届くものは所有者の承認も要る。

```sh
python3 bin/live-apply.py patch --source <新しいpatch> --target ~/.dsh/profiles/<p>/cordis.patch.yml \
  --record <homeの外の空のディレクトリ> [--owner-approved '<承認の出どころ>']
```

- 対象は `~/.dsh/cordis.patch.yml` か、`package.json` のあるprofileの `cordis.patch.yml` だけである。対象、`profiles`、profileのディレクトリがsymlinkなら拒む。`desktop` と、Coreが受け付けない名前のprofileも拒む。
- 本番でないprofileは `web` だけとして扱う。homeのpatchと、ほかのすべてのprofileは `--owner-approved` がなければ拒む（exit 3）。中身が同じなら何もせず終わる（exit 0。承認は要らない）。
- 手順は次の順序で進める。前の確認（`dsh --profile <p> --dump-config`、workerとsecond reviewerの経路のprobe）、反映、後の確認を行う。失敗したら元に戻して、戻したあとの確認を行う。後の確認と戻したあとの確認のprobeは、30秒あけて一度だけ流し直す。
- probeを流す前に、`headless` のprofileがあることを毎回確かめる。`dsh headless` が作ってしまうためである。probeの子プロセスは自分のsessionで動かす。`--probe-timeout`（既定600秒）を超えたらprocess groupごと止める。子の環境から `RUN_WORKER_EVENTS` を外す。
- 対象は、symlinkをたどらない一時ファイル（`O_EXCL|O_NOFOLLOW`）を書いてから `os.replace` で置き換える。元のmodeを保つ。新しく作る対象のmodeは `0o600` とする。
- 記録（`--record`）は、`source.yml`、`backup.yml`（または `backup-absent`）、確認ごとの `.out`/`.err`、`summary.json` を残す。ディレクトリは `0o700`、ファイルは `0o600` とする。homeの中（symlinkの別名を含む）には置けない。
- SIGINTでは、対象を書き換えていれば元に戻してexit 130で終わる。statusが決まったあと（後の確認が通ったあとなど）は、SIGINTをblockしたまま終わるので、そのSIGINTは無視される。probeの子プロセスはSIGINTをblockした状態で起動する。届いたSIGINTは起動の直後に受け取って、process groupごと止める。
- 置き換えに失敗したときは、一時ファイルを消してから終わる。

| exit | status | 意味 |
|---|---|---|
| 0 | `applied` / `unchanged` | 反映して後の確認が通った。または中身が同じで何もしなかった |
| 1 | `error` | ファイル操作が失敗した。書き換えていれば元に戻した |
| 2 | （なし） | 使い方の誤り。何も書いていない |
| 3 | `refused` | 本番に届くのに承認がない |
| 4 | `pre-probe-failed` | 前の確認が失敗した。対象は変えていない |
| 5 | `rolled-back` | 後の確認が失敗し、元に戻して、戻したあとの確認が通った |
| 6 | `rollback-failed` | 戻したあとの確認も失敗した、または元に戻せなかった。liveは壊れたままの可能性がある |
| 130 | `interrupted` | SIGINTで止めた |

反映が通っても、常駐のservice（bridge、web）はpatchを次の起動で読む。scriptは `LIVE_APPLY_RESTART_NEEDED` でそれを知らせるが、serviceの再起動はしない。exit 1、5、6、130では、新しいpatchが置かれていたあいだにserviceが落ちて再起動した可能性を `LIVE_APPLY_CHECK_SERVICE` で知らせる。

## #50: liveなbuildの出所と、Core分離の検査を通す案

[#50](https://github.com/kkiyama117/deepseek-harness-plugins/issues/50)の調査（2026-11-06、読み取りのみ）。

### liveなbuildが何からできているか

- Coreの `HEAD` は `971944fcca`（upstreamの `ce7073d512` のmerge）である。`ce7073d512..HEAD` の差分は、承認済みの例外のsidebarの5ファイルだけである。
- Coreの作業ツリーには未コミットの変更が11ファイル（inspectorの9ファイル、`apps/web/tsconfig.json`、`tsconfig.host.json`）と、未追跡のファイルがある。どれも2026-10-30 17:15:27の更新である。
- Coreの全 `lib/`（377個）は2026-10-30 17:16〜17:17にbuildされた。`HEAD` のcommit（同日16:09）と未コミットの変更より後である。
- liveなbuildは未コミットの変更を含む。inspectorの `lib/client.js.map` と `lib/client.page.js.map` の `sourcesContent` は、`src/client/plugin.ts`、`src/client/bottom/locales.ts`、`src/client/bottom/page.tsx` で作業ツリーと一致し、`HEAD` とは一致しない。
- inspectorは `web` profileのbundle `@deepseek-ai/dsh-experimental-inspector-profile` から入る。`headless` と `ai-reference-store-daily` のbundleには入らない。tsconfigの2ファイルがほかのpackageのbuildをどう変えたかは確かめていない。

つまり、liveなbuildは「`971944fcca` と、作業ツリーの未コミットの変更11ファイル」からできている。

### 検査が失敗する理由

`bin/check-core-separation.py` は `approvedUpstreamBase` から作業ツリーまでの差分を見る。

1. 基準の `22ddee3792` が10-30のupstreamの更新より古い。そのため、その更新の全部が例外の外の差分に数えられる。
2. 例外のpatchのhashが変わった。`ce7073d512` を基準にした5ファイルの差分は、記録したpatchとREADME.i18n.yamlのhashとhunkの行番号だけが違い、コードとテストのhunkは同じである。merge前の `93ea327f75` では、記録した基準でhashが一致する。
3. 未コミットの変更と未追跡のファイルがある。

### 検査を通す状態に戻す手順の案

1. **所有者が決める。** 未コミットの変更と未追跡のファイルの扱い（このリポジトリへ移す、upstreamに出す、捨てる）を所有者が決める。運用スクリプトはこのリポジトリの `bin/` に置く（[管理区分](../SOURCE-OWNERSHIP.md)）。決まるまでCoreの作業ツリーとstashに触らない。inspectorの変更を捨てると、次のbuildでWebのinspectorの画面からその変更が消える。
2. **例外を再レビューする。** `ce7073d512` を基準に、sidebarの5ファイルの差分をsecond reviewerに読ませる。upstreamはその間にsidebarのpackageを変えている。そのため、ガードが新しいviewでも意味を保つかを確かめる。人が承認したら、`core-exceptions.json` の `approvedUpstreamBase` と `patchSha256` を、作業ツリーがcleanな状態で検査が出す値に変えるPRを出す。失敗を通すためだけにhashを変えない。
3. **buildし直す。** 作業ツリーがcleanになったあと、Coreでbuildする。これは経路Aの反映であり、全profileと本番に届く。前後のprobe、全 `lib/` の写し、人の承認のもと、反映のscriptで行う。
4. **記録する。** 検査が `passed` になること、build時の `HEAD` と作業ツリーがcleanだったことを `reports/agents/` に残す。buildの出所をあとから確かめられるよう、build時の `HEAD` と作業ツリーの状態を書き出す仕組みは別のissueで扱う。
