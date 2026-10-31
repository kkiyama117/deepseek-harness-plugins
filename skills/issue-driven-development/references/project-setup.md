# プロジェクト設定と報告

共通フローは[スキル本文](../SKILL.md)が担当する。このページはプロジェクトごとに確認する事項と、GitHubへの記録方法をまとめる。専用の設定ファイルや新しいラベル群を必須にしない。既存のCONTRIBUTING、README、CI定義で分かる事項は参照し、重複した一覧を保守しない。

## プロジェクト設定

| 確認事項 | 内容 |
|---|---|
| 課題とコードの管理先 | Issueを作るrepositoryと、変更するrepository。別の場合は両方の関係 |
| 指示・構成 | プロジェクトの指示、構成、対象パッケージの説明 |
| 検証 | 対象変更に必要なテスト・型検査・文書検査等と、その前提 |
| 反映先 | 既定ブランチ、配布物、稼働環境のうち何を今回の完了対象にするか |
| 権限 | 調査、変更、公開、push、merge、配備、外部サービス利用の許可範囲 |
| 実行条件 | 必要な場合のみ、モデル経路、予算・時間・試行上限、停止方法 |
| 作業の分担 | 担当、既存の作業、ブランチまたはworktree、ファイルの所有範囲 |

配布元の設定例は [deepseek-harness-pluginsのCONTRIBUTING](https://github.com/kkiyama117/deepseek-harness-plugins/blob/main/CONTRIBUTING.md)を参照する。他プロジェクトへスキルを持ち込む場合は、そのプロジェクトの案内を使い、DSH固有のコマンドや権限を引き継がない。

## GitHubでの操作

GitHub UIまたは認証済みの `gh` CLIを使う。次は構文例であり、そのまま実行する指示ではない。`OWNER/REPO`、検索語、Issue番号、本文ファイルを対象に合わせる。作業ディレクトリから公開先を推測せず、`--repo` を明示する。

```sh
# open/closedの両方で既存課題を調べる。検索上限に達したら検索語を絞る。
gh issue list --repo OWNER/REPO --state all --search '検索語' --limit 50
gh pr list --repo OWNER/REPO --state all --search '検索語' --limit 50
gh issue view 12 --repo OWNER/REPO --comments

# 公開内容を確認したUTF-8ファイルを渡す。Issue本文をshellのコードにしない。
gh issue create --repo OWNER/REPO --title '具体的な困りごと' --body-file issue.md
gh issue comment 12 --repo OWNER/REPO --body-file result.md
```

状態はGitHubのopen/closedと、必要時のコメントで表す。着手、ブロッカー、PR作成、結果に変化があったときに更新し、ツール呼出しごとの実況は投稿しない。ラベルやProjectが既にある場合はその運用に従う。専用の状態ラベル・ボード・定期巡回は必須ではない。

## 中断と再開

既存のIssueコメントや作業メモに、次の担当が推測せず再開できる情報を残す。専用ファイルを増やす必要はない。公開先には秘密や私的な実行記録を含めない。

- 元の目的・未達の完了条件と、決定した設計・その理由。
- 対象ブランチ・commit・未コミット変更と編集範囲。
- 実施した検証の結果と証拠、未解決のレビュー指摘。
- 次に行う作業、ブロッカー、残る権限・実行上限。

再開時はメモを現在のGit状態と成果物に照合する。前の担当の「完了」という報告だけで通過扱いにせず、変更や不確実性に応じて必要な確認を行う。再開したという理由だけで全検証を繰り返さない。

## 結果報告

小さな作業では以下を短い文章にまとめてよい。実行記録の全文は貼らず、公開可能な要点と証拠へのリンクを残す。

```text
変更: PR / commit / 更新した成果物
完了条件: 各条件について確認方法と結果。未確認は未確認と記す
検証: 実行したコマンドや操作、対象版・環境、成功・失敗・skip
反映: PRのみ / merge済み / 配備済み。確認した対象を明記
残作業: ブロッカー、必要な権限、追跡Issue。なければなし
振り返り: 詰まった工程、採用・撤回した手順、次に確かめること
```

## 他プロジェクトで使う

1. `SKILL.md` と `references/project-setup.md` の2ファイルをこの相対配置でコピーするか、ソースの場所を案内する。外部リンク先のスキルやプロジェクト資料は必要なときだけ参照する。
2. ハーネスがスキルをサポートするなら、その公開された登録方法を使う。登録できない環境では、プロジェクトの指示からスキル本文を参照する。
3. 上の設定事項を対象プロジェクトで確認し、通常の開発依頼を一件進める。作成・検証・反映の仕組みは各プロジェクトのものを使う。

スキルが一覧に載ったことは、全agentが読んだ証拠でも制限が強制された証拠でもない。利用するagentには適用する手順を明示し、成果と記録を確認する。

## 設計の参考資料

担当・セッション・レビューの分け方を見直す際に参照する。以下は設計の根拠であり、このフローの効果を測定した結果ではない。

- [自分のClaude Codeハーネスの変遷 #3（フロー更新編）](https://zenn.dev/i_shinya/articles/harness-fewer-subagents)：機能内の作業を同じ主担当が進め、文脈の受け渡しを減らした実践例。PRの行数や複数モデルによるレビューは著者の運用であり、共通の必須条件にはしない。
- [Anthropic: When to use multi-agent systems](https://claude.com/resources/articles/building-multi-agent-systems-when-and-how-to-use-them)：工程名ではなく文脈の境界で分け、独立した調査・検証や接続仕様の明確な作業に委任を使う。
- [Anthropic: When to fold subagents into your main agent loop](https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop)：手順や知識は必要時に読み込むスキル・ツールで提供し、構成の変更は一つずつ同じ評価対象で比較する。
- [Anthropic: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)：小さな実装単位、検証結果、再開可能な引き継ぎを重視する。専任の初期化agentや毎回の全E2E実行まで一律には導入しない。

単一agent・複数agentのどちらかを常に優位とせず、要求達成と回帰を先に確認する。比較するときは総合点だけでなく、以前は通っていた個別ケースが失敗するようになっていないかも確認する。記事の費用・速度の数値をこの環境の保証や固定閾値にしない。
