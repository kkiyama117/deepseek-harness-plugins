# liveなDSHへの反映

`PATH` の `dsh` は `/data/softwares/deepseek-harness/apps/cli/lib/bin.js` を指し、どのプロジェクトのworker（kstackの `run-worker.sh`）もこれを動かす。Coreのbuild、`~/.dsh` のprofileとpatch、skillのリンク、このリポジトリの主checkoutの一部は、すべてliveである。変更は一つずつ反映し、前後をprobeで確かめ、失敗したら戻す（[#48](https://github.com/kkiyama117/deepseek-harness-plugins/issues/48)）。起動先の検査は[配置検査](runtime-placement.md)、Core差分の検査は[管理区分](../SOURCE-OWNERSHIP.md)が受け持つ。

この文書は経路の仕組みを書く。いま入っている版や観測の記録は配置の一覧にあたるので、Gitに入れず `reports/agents/` に置く。

## liveを読むもの

| 読み手 | 起動 | profile | いつ読み直すか |
|---|---|---|---|
| worker・reviewer（`run-worker.sh`） | 実行ごとに `dsh headless --patch <一時patch> ...` | `headless` | 次の実行。常に最新を読む |
| `slack-intake-bridge.service`（本番） | 常駐。`--profile headless --patch configs/dsh-slack-worker-config/daemon.patch.yml` | `headless` | serviceの再起動。`Restart=on-failure` なので、落ちて自動で再起動したときにも読む |
| `ai-reference-store-daily.service`（本番） | timerで毎日1回。`daily-start.sh` 経由 | `ai-reference-store-daily` | 次のtimer起動 |
| `dsh-web-managed.service` | 常駐。`dsh web` | `web` | serviceの再起動（client bundleは下の注を参照） |

一回の起動は、profileの `package.json` の `dsh.profile.bundles` の順に各bundleのpatch、profileの `cordis.patch.yml`、homeの `~/.dsh/cordis.patch.yml`、`--patch` の順に重ねる（`apps/cli/src/profile-boot.ts`）。どの起動もprofileの `cordis.yml` を同じ空の内容で書き直すので、`--dump-config` も含め、`dsh` の起動は `~/.dsh` を書く操作である。Coreに同梱されたテンプレートの名前（`headless`、`web` など）のprofileが無いまま起動すると、そのprofileを作ってしまう（`loadProfile`）。ほかの名前は作らずに失敗する。反映のscriptとprobeは、`dsh` を呼ぶ前にそのprofileの `package.json` があることを確かめ、なければ止まる。

`headless` profileはworkerと本番の両方が使う。`headless` に届く変更は、次のworker実行にすぐ届き、本番にはbridgeの次の再起動で届く。後者は人が再起動しなくても、bridgeが落ちれば起きる。

## 反映の経路

「本番」は、その経路が `headless`・`ai-reference-store-daily` のprofileか本番のserviceに届くことを表す。本番に届く反映は所有者の承認が要る。反映のscriptは、本番でないと決めたprofile（いまは `web` だけ）の一覧を持ち、一覧にないprofileはすべて本番として扱う。

| 経路 | 何が変わるか | 届く先と時期 | 戻し方 | 本番 |
|---|---|---|---|---|
| A. Coreのbuild（Coreで `pnpm build`） | `apps/*/lib`・`packages/*/lib` の全部。Gitの管理外 | 全profile。workerは次の実行、常駐serviceは再起動、dailyは次の起動 | build前に全 `lib/` の写し（tar）を取り、戻すときはそれを展開する。Gitからは戻せない | 届く |
| B. Coreのcheckoutの更新（upstreamのmerge） | ソースと、bundleのpatch（`packages/bundle/*/cordis.patch.yml` などのyml） | bundleのymlはbuildなしで次の起動に届く。コードはAのbuildまで届かない | 前のcommitに戻し、Aを戻す。Coreの作業ツリーと未コミットの変更は所有者のもの | 届く |
| C. profileへのbundleの追加・更新（`dsh plugin --profile <p> add ...`。profileの中でpnpmを動かす） | profileの `package.json`、`pnpm-lock.yaml`、`node_modules` | そのprofileの次の起動 | 3ファイルと `node_modules` の写しから戻す。`file:` のtarballは導入時に `node_modules` へ展開されるので、`releases/` のtarballを上書きしても再導入まで届かない。戻すには前の版のtarballを残しておく | `web` 以外のprofileなら届く。`web` でも、homeのpatchが読むプラグインなら届く（下の「経路をまたぐつながり」） |
| D. `link:` の依存 | リンク先のディレクトリの中身 | そのprofileの次の起動。導入もbuildも要らない（`.mjs` のプラグイン）。Coreへの `link:` はA・Bに従う | リンク先を前の内容に戻す | リンク先とprofileによる |
| E. profileのpatch（`~/.dsh/profiles/<p>/cordis.patch.yml`。`desktop` はElectronのアプリだけが扱うので対象外） | そのprofileの行の上書き | そのprofileの次の起動 | 前のファイルの写しを戻す | `web` 以外のprofileなら届く（一覧にないprofileは本番として扱う） |
| F. homeのpatch（`~/.dsh/cordis.patch.yml`） | 全profileの行。sessionとstorageの保存先（[#45](https://github.com/kkiyama117/deepseek-harness-plugins/issues/45)）を含む | 全profileの次の起動 | 前のファイルの写しを戻す | 届く |
| G. このcheckoutのdaemon patch（`configs/dsh-slack-worker-config/daemon.patch.yml`） | 本番bridgeの行 | bridgeの次の再起動だけ | 前の内容に戻し、bridgeを再起動する | 届く |
| H. このリポジトリの主checkoutの更新（`git pull` など） | DとGのリンク先 | `web` が `link:` で読むプラグイン（`plugins/llm-fallback`、`configs/*-mcp*` など）と、bridgeが読むdaemon patch。PRのmergeだけではliveは変わらず、主checkoutを更新したときに変わる | 前のcommitの内容に戻す | `configs/dsh-slack-worker-config/` が変われば届く |
| I. `~/.dsh/skills` のリンク | DSHが見つけるskill | 次の起動（起動中の再走査は未確認）。リンク先がkstackのcheckoutなら、kstackの変更がそのまま届く | リンクかリンク先を戻す | skillを使う起動に届く |
| J. `run-worker.sh` の一時patch | workerのmodelの経路と認証情報の有効化 | worker・reviewerの次の実行だけ | kstackの所有者が戻す | 届かない |

主checkoutの更新（H）は、どれもliveへの反映として扱う。前後のprobeを流し、manager の go を得てから行う。`configs/dsh-slack-worker-config/` が変わる更新は本番への反映であり、所有者の承認が要る。

経路をまたぐつながり:

- homeのpatch（F）が `web` profileの `node_modules` の中のプラグインを `insert` すると、`web` profileの依存の更新（C）が `headless` のworkerと本番にも届く。Cを `web` だけの変更と見なさない。
- `web` profileの `node_modules` に、`package.json` に書かれていないリンクがあることがある。bundleにもpatchにもなければ読み込まれないが、そのprofileでpnpmを動かすと消えることがある（未確認）。Cの前に、`package.json` にないリンクの一覧を写しに含める。
- Webのclient bundleは `lib/` から配られる。Aのあと、hostを再起動しなくても、開いた画面の再読込でclientだけ新しくなることがある（未確認）。
- Aの最中は `lib/` が書きかけになる。そのあいだに起動したworkerや、落ちて再起動したserviceは壊れたbuildを読む。Aは実行中のworkerがないときに行う。

Node（serviceのunitはmiseの `latest` を指す）とsystemdのunitもliveだが、このリポジトリの反映の手順には含めない。

## probe

反映の前と後に、既定のworkerの経路で一行のprobeを流す。

```sh
d=$(mktemp -d)
printf 'What is 17*23? Reply with only the number.' |
  /data/softwares/kstack/skills/kiyama-mode/scripts/run-worker.sh --read-only "$d" dsh ollama-cloud deepseek-v4.1-flash high
```

成功は、exit 0、標準出力を空白で整えたものがちょうど `391`、`$d` が空のまま、の三つがそろうこと。second reviewerの経路（`dsh openai-codex gpt-6.1-sol high`）も同じprobeを流す。この経路はprofileの `credentials` 行と保存済みのproviderのloginを通るので、workerの経路では見えない壊れ方を見つける。

providerの一時的な失敗（`PI_AI_ERROR` の過負荷など）は、反映が壊したことと区別できない。後のprobeと、戻したあとのprobeが失敗したら、30秒あけて一度だけ流し直し、二度とも失敗したら失敗とする。前のprobeが失敗したら反映しない。

probeはsessionを一つ作る。保存先はhomeのpatch（F）が決める。

## #50: liveなbuildの出所と、Core分離の検査を通す案

[#50](https://github.com/kkiyama117/deepseek-harness-plugins/issues/50)の調査（2026-11-06、読み取りのみ）。

### liveなbuildが何からできているか

- Coreの `HEAD` は `971944fcca`（upstreamの `ce7073d512` のmerge）。`ce7073d512..HEAD` の差分は、承認済みの例外のsidebarの5ファイルだけである。
- Coreの作業ツリーには未コミットの変更が11ファイル（inspectorの9ファイル、`apps/web/tsconfig.json`、`tsconfig.host.json`）と、未追跡のファイルがある。どれも2026-10-30 17:15:27の更新である。
- Coreの全 `lib/`（377個）は2026-10-30 17:16〜17:17にbuildされた。`HEAD` のcommit（同日16:09）と未コミットの変更より後である。
- inspectorの `lib/client.js.map` と `lib/client.page.js.map` の `sourcesContent` は、`src/client/plugin.ts`、`src/client/bottom/locales.ts`、`src/client/bottom/page.tsx` で作業ツリーと一致し、`HEAD` とは一致しない。liveなbuildは未コミットの変更を含む。
- inspectorは `web` profileのbundle `@deepseek-ai/dsh-experimental-inspector-profile` から入る。`headless` と `ai-reference-store-daily` のbundleには入らない。tsconfigの2ファイルがほかのpackageのbuildをどう変えたかは確かめていない。

つまり、liveなbuildは「`971944fcca` と、作業ツリーの未コミットの変更11ファイル」からできている。

### 検査が失敗する理由

`bin/check-core-separation.py` は `approvedUpstreamBase` から作業ツリーまでの差分を見る。

1. 基準の `22ddee3792` が10-30のupstreamの更新より古いので、その更新の全部が例外の外の差分に数えられる。
2. 例外のpatchのhashが変わった。`ce7073d512` を基準にした5ファイルの差分は、記録したpatchとREADME.i18n.yamlのhashとhunkの行番号だけが違い、コードとテストのhunkは同じである。merge前の `93ea327f75` では、記録した基準でhashが一致する。
3. 未コミットの変更と未追跡のファイルがある。

### 検査を通す状態に戻す手順の案

1. **所有者が決める。** 未コミットの変更と未追跡のファイルの扱い（このリポジトリへ移す、upstreamに出す、捨てる）。運用スクリプトはこのリポジトリの `bin/` に置く（[管理区分](../SOURCE-OWNERSHIP.md)）。決まるまでCoreの作業ツリーとstashに触らない。inspectorの変更を捨てると、次のbuildでWebのinspectorの画面からその変更が消える。
2. **例外を再レビューする。** `ce7073d512` を基準に、sidebarの5ファイルの差分をsecond reviewerに読ませる。upstreamはその間にsidebarのpackageを変えているので、ガードが新しいviewでも意味を保つかを確かめる。人が承認したら、`core-exceptions.json` の `approvedUpstreamBase` と `patchSha256` を、作業ツリーがcleanな状態で検査が出す値に変えるPRを出す。失敗を通すためだけにhashを変えない。
3. **buildし直す。** 作業ツリーがcleanになったあと、Coreでbuildする。これは経路Aの反映であり、全profileと本番に届く。前後のprobe、全 `lib/` の写し、人の承認のうえで、反映のscriptで行う。
4. **記録する。** 検査が `passed` になること、build時の `HEAD` と作業ツリーがcleanだったことを `reports/agents/` に残す。buildの出所をあとから確かめられるよう、build時の `HEAD` と作業ツリーの状態を書き出す仕組みは別のissueで扱う。
