# 開発と改善への参加

機能追加、bugfix、共通の開発手順への提案は [Issues](https://github.com/kkiyama117/deepseek-harness-plugins/issues)で受け付けます。人間もAI agentsも同じ入口を使います。通常の開発手順は [issue-driven-development](skills/issue-driven-development/SKILL.md)を参照してください。

## 困りごとを伝える

[新しいIssue](https://github.com/kkiyama117/deepseek-harness-plugins/issues/new/choose)から「困りごと・改善提案」を選びます。「何をしようとして、どこで困ったか」だけでも構いません。期待する結果や再現方法が分かれば追記してください。空のIssueも利用できます。設計案や解決策を用意する必要はありません。

起票前に似たIssueを検索してください。同じ課題があれば追記できます。公開リポジトリなので、認証情報・私的な会話・内部URL・生ログは貼らず、必要な部分だけを安全な再現例にしてください。AI agentsは事実と仮説を区別し、足りない情報を補います。

他プロジェクト固有の不具合は、そのプロジェクトへ報告します。複数プロジェクトで使うスキルや開発手順の改善はここで扱い、必要なら元のIssueにリンクします。

## このリポジトリで開発する

| 項目 | このリポジトリの設定 |
|---|---|
| Issue・コード | `kkiyama117/deepseek-harness-plugins` |
| 既定ブランチ | `main`。通常は作業ブランチとPRを使い、対象Issueを関連付ける |
| 管理区分 | [SOURCE-OWNERSHIP](SOURCE-OWNERSHIP.md)。独自機能をDSH本体のローカル差分にしない |
| 構成・検証 | [READMEのDevelopment](README.md#development)と変更するパッケージのREADME。rootのbuild/testは全パッケージを対象にしない |
| 公開範囲 | [Repository scope and ownership](README.md#repository-scope-and-ownership)。私的な実行記録・配置情報はGitに入れない |
| merge・配備 | 所有者から認められた範囲で実施する。起票権限からmerge権限やローカルプロファイル変更権限を推定しない |
| 課題の選択 | ユーザーが指定したIssue、または事前に合意した優先度・対象範囲から選ぶ。AIによる常駐巡回や自動着手は設定していない |

文書・テンプレートのみの変更では、ローカルリンク、テンプレートのYAML構造、`git diff --check`、公開内容を確認します。Issueフォームは既定ブランチへの反映後にGitHub上でも確認します。コード・スキル付属スクリプトを変更する場合は、その対象の検証も行います。

スキルの手順を変えた場合は、人間の短い報告、AIによる再現可能なbug報告、他プロジェクトからの共通改善、重複、権限不足、検証失敗について、次の操作と完了判断が明確か確認します。これは手順の机上確認であり、実際の開発での効果測定の代わりにはなりません。

## AI agentsの入口

このリポジトリでは [AGENTS.md](AGENTS.md)から共通スキルを案内します。既に [orchestrate-agents](skills/orchestrate-agents/SKILL.md)を使う環境でも、Issue起点の開発・起票では共通スキルを参照します。新しいスキルの配布や他プロジェクトへの組み込み方は[プロジェクト設定](skills/issue-driven-development/references/project-setup.md#他プロジェクトで使う)を参照してください。

`issue-driven-development` は課題の受付から反映・振り返りまで、`orchestrate-agents` は必要に応じた実行構成・委任を担当します。[implement-task](skills/implement-task/SKILL.md)は旧ツールに依存する参考実装であり、この手順の実行経路には使いません。

## 改善の効果を確かめる

手順を整えたことと、開発が改善したことを区別します。最初の導入は [Issue #2](https://github.com/kkiyama117/deepseek-harness-plugins/issues/2)で追跡します。その後は実際の機能追加・bugfixで使い、重要な詰まりをIssueに戻します。計測や報告の作業自体が負担になった場合も改善対象です。
