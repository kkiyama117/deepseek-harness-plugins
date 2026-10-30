# Coreと独自プラグインの管理区分

## 基本方針

DSH本体は公式upstream/masterを基準にする。独自の業務機能、ポリシー、プリセット、運用スクリプトと設計資料はこのリポジトリで管理し、プロファイルにはbundle選択・導入先・ユーザー設定を置く。配布アーカイブを外に置くだけでは、Coreに残る独自ソースの分離にはならない。

## Coreの例外

許容するCore差分は[core-exceptions.json](./core-exceptions.json)に記録したsidebarの破棄済みViewの診断抑止だけである。変更対象は実装・試験・対応READMEの5ファイル。破棄状態と診断処理は上流Viewの内部にあり、公開ServiceやSlotからその診断だけを制御する手段がない。全体のconsole抑止やsidebar全体の複製では変更範囲が広がるため、この小さな修正を例外として保持する。

例外はファイル名だけでなく差分のhashで照合する。上流基準や例外の内容が変わった場合は再レビューし、失敗を通す目的でhashを自動更新しない。

```sh
uv run --no-project bin/check-core-separation.py --core /data/softwares/deepseek-harness
```

この検査はCoreの追加ファイル・未記録変更を拒否する。通常の配置・稼働検査は[配置検査](./bin/runtime-placement.md)が担当し、分離検査とは別に実施する。

## 独自機能と設定

- [Goal acceptance](./plugins/dsh-goal-acceptance/README.md)がポリシーと外部のGoal/subagent提供方を所有する。公式Goal/Subagentソースには登録APIを追加しない。
- [pilot](./plugins/dsh-request-acceptance-pilot/README.md)が実際のSession制限と配置設定を所有する。通常Sessionへ対象を広げない。
- [日次プリセット](./presets/ai-reference-store-daily/README.md)を含む独自プリセットはこのリポジトリで管理する。Harness home内の旧プリセットディレクトリを保守元にしない。
- 私的な設計資料・レビュー結果・実行記録は公開対象外のローカル領域に置く。公開用に引用・記録を書き換えず、資料ごとGit管理から除外する。
- モデル確認などの運用スクリプトはこのリポジトリのbinで管理する。Coreのbinへ戻さない。

第三者パッケージや別の研究プロジェクトが所有する独立プラグインの参照先は、それぞれの管理先を保持する。それらをCoreのローカル改変と同一視せず、移動・削除前に利用箇所を確認する。

## 変更時の検証

ポリシーの直接・Remote呼出し、選択Sessionの範囲、提供方の再読込、過去の記録の読み取り、実プロファイル構成を検証する。サービス提供方を別のLoader行へ移す際には、元の行の設定は自動継承されない。委任深度などの実効値を新しい行へ明示する。

配布物は[pack-local-bundle.py](./bin/pack-local-bundle.py)で収録ファイルの内容まで照合する。稼働環境への反映前に、その配布物そのものを使った導入と構成確認を行う。
