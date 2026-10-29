# 保守対象と保管対象

この文書は、自作拡張の現行運用と、参照・復旧のために残す旧実装を区別するための一覧です。ファイルの存在や未マウントという外形だけでは、削除可否を判断しません。

## 現行運用

稼働対象は各profileの依存・bundle選択と上位patchから確認します。現在のWeb、headless、日次profileは、次の旧managed 5点セットを参照していません。現行プリセットは公式部品と必要な独自拡張を組み合わせます。`managed-standard`などの互換preset名は、旧managed providerの使用を意味しません。

[Goal acceptance](../dsh-goal-acceptance/README.md)は現在の外部保守パッケージです。Goal/subagentの提供方もこのパッケージが所有し、[限定pilot](../dsh-request-acceptance-pilot/README.md)から読み込みます。試験は[パッケージ内](../dsh-goal-acceptance/tests/acceptance.spec.ts)で管理します。Core内の実装や登録API追加には戻しません。[本体と外部実装の管理区分](../SOURCE-OWNERSHIP.md)に従います。

## 削除した旧managed 5点セット

`dsh-managed-runtime`、`dsh-managed-subagents`、`dsh-managed-session-jsonl`、`dsh-managed-cordis`、`dsh-ui-settings-host-describe`は削除済みです。現行profile・skill・サービスからの利用はなく、専用の旧release／起動helper、lockfileの旧importer、workspaceリンクも削除しました。生成物・内蔵の旧テストを含むディレクトリは残していません。

別の場所へソース一式をコピーして保管することはしません。旧実装が調査に必要になった場合はGit履歴を参照します。`managed-standard`／`managed-cordis`という名前の現行互換プリセットとは別物です。削除によってSession履歴を変更したり、未知の必須イベントや保存済み世代を削除したりすることはありません。

## 削除しない参照実装

- [subagent-fallback](../subagent-fallback/index.mjs)は[implement-task](../skills/implement-task/SKILL.md)と仕様・replayから参照されます。旧委任APIのまま現行環境へ追加せず、再使用時は呼出し側と仕様を含めて移行します。
- Web Search／Cursor adapterの旧invariant companionは旧開発環境のソースとして残します。現行masterには依存先のinvariant registryがないため、そのままの再導入は対象外です。
- 旧UI-familyのコピー、旧marketのコピー、停止済み互換版は、未導入という理由だけで削除しません。個々の参照と固有差分の調査が必要です。
- release archive、Session履歴、hash記録、復旧用バックアップは、保守対象外のソースと混同して削除しません。

## 保守の変更範囲

保守終了実装の削除は、保存データの移行や旧機能の同等性保証ではありません。稼働profileの切替・package更新は正規Plugin Managerで行い、参照のある実装・試験の削除とは別に検証します。
