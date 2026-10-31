# DSHの常用配置と起動前検査

常用の実装は `/data/softwares/deepseek-harness` に置く。アップグレードの作業ツリーをGUI・Slackワーカー・日次処理の常用起動先にしない。

## 検査の実行箇所

3サービスの `runtime-placement.conf` が `check-runtime-placement.py` を `ExecStartPre` として実行する。検査が失敗すると、そのサービスの起動は失敗する。稼働中の正常なプロセスを検査のためだけに停止することはない。

検査対象はsystemdが読み込んだ実効 `ExecStart`、GUIの `WorkingDirectory`、各profileの直接依存である。CLIとNodeの実体、通常配置が主Gitチェックアウトであること、依存先の存在を確認する。直接依存の `/tmp`・`/var/tmp`・`/run`・`.artifacts`・`.dsh-maintenance`・Git worktreeへの参照を拒否する。配布用tarballはファイルとして存在を検証するが、作業ディレクトリ全体の残置検査はしない。

pnpmのworkspace設定・lockfile・modules設定も検査し、撤去済みの旧DSHチェックアウト名や `.dsh-maintenance` への参照があれば拒否する。直接依存が正常でも、overrideから旧配置を再導入させない。

更新後の確認は次で行う。

```sh
node /data/softwares/deepseek-harness-plugins/bin/verify-runtime-location.mjs
```

このコマンドは配置検査に加え、3サービスすべてに無視不可の起動前検査が設定されていること、GUIとワーカーの実行パス、Slack接続状態、認証付きローカル／HTTPS画面の表示を確認する。

検査の試験は次で行う。試験用ディレクトリは終了時に削除し、systemdの一時ユニットも終了時に回収する。

```sh
uv run --no-project --offline --python /usr/bin/python3 /data/softwares/deepseek-harness-plugins/bin/test-runtime-placement.py --live
```

## 更新時の終了条件

必要なソースと未コミット変更を通常配置に統合し、内容一致を確認する。起動・直接依存の参照先を通常配置へ直し、上の確認を通す。作業ツリーにしか存在しない変更・成果物がないことと稼働参照がないことを確認してから、今回作った一時ツリーを削除する。作業ツリーを別名の常用ディレクトリに変えるだけでは完了としない。

旧 `cutover-dsh-master.py`、`retry-dsh-master.py` は、一時作業先を常用先へ昇格させるため実行を停止する。過去の実装は調査用に保持し、通常配置へ単純にパス置換して再利用しない。

## 適用範囲と限界

2026-10-16の問題は、動作確認だけで更新を完了扱いにし、一時作業先へのsystemd設定とprofile依存を残したことによる。この検査はその常用起動経路を制限する。利用者と同じ権限を持つ処理による検査そのものの書換え・削除、systemdを経由しない直接起動、プラグインコード内の任意の絶対パスまでは防げない。機械的に残骸と判別できないファイルを自動削除する仕組みでもない。

起動を拒否された場合は `journalctl --user -u <サービス名>` の `PLACEMENT_DENIED` を読み、配置と参照を修正する。検査を外して起動を通すことを復旧方法にしない。
