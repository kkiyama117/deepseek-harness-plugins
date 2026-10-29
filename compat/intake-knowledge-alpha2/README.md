# Intake Knowledge（読取専用・段階0〜1）

明示的に共有許可した資料だけを検索・読取するDSH presetです。既存の日次取り込み、Slack判断・検証、GUI、kura、skillsを変更しません。検索・読取自体はモデルやネットワークを呼びません。

## 境界

- `intake_search` と `intake_read` だけを新しい `intake-knowledge` presetへ登録します。通常セッションのツールや既定presetは変えません。
- 毎回scopeを読み直し、共有する資料ID・内容版・要約・分類・媒体・活用方針を照合します。確認後の変更、記事の承認取消、壊れた記事はエラーになります。
- 確認済みReader記事はLLMが整理した文章です。原著の原文ではなく、手順の採用許可でもありません。
- scope作成時に本文を選ばなければ、本文の読取・採点はしません。本文が不足・曖昧な場合、保存テキスト・Slack本文・private evidenceへfallbackしません。
- v1の共有フィールドはID、URL、要約、分類、媒体、活用方針の固定セットで、確認済み記事本文は任意です。個々のフィールドを自由に組み合わせるUIはありません。
- `usage_policy`や要約が変わっても共有版が変わるため、新しいdraftをレビューする必要があります。厳格な少数試用を優先した仕様です。
- 1 fresh sessionあたり検索2回・読取3回。これは生存中Agentのツール上限であり、プロセス再起動をまたぐ課金枠ではありません。
- 初期のモデル試用は、別途承認された評価経路で行います。このpresetの選択だけではモデル・effort・トークン予算を固定しません。
- 同一OSユーザーの別プログラムによるファイル編集まで防ぐsandboxではありません。モデルにscope承認・汎用書込・実行のツールを与えないことで、この試用からの変更を制限します。

## 人による共有範囲の作成

次はローカル管理操作です。モデル向けツールには公開しません。実際のパス・IDは実行前に確定してください。

```bash
# prepareは未承認JSONと、その内容だけを見せるHTMLプレビューを作る。
# 出力先は原資料ストアの外、privateなディレクトリ。既存ファイルを置換しない。
aistore --store /absolute/store --json knowledge-scope prepare \
  --state-home /absolute/management-home \
  --out /absolute/private/sharing/draft.json \
  --id 'url:https://example.test/one' \
  --include-article

# 人がプレビューの内容とdraft hashを確認し、その具体的な共有を許可した後だけ実行。
aistore --store /absolute/store --json knowledge-scope approve \
  --draft /absolute/private/sharing/draft.json \
  --expected-hash EXACT_DRAFT_SHA256 \
  --out /absolute/private/sharing/scope.json \
  --approval-id HUMAN_AUTHORIZATION_RECORD
```

`approval-id` は監査記録で、本人認証ではありません。モデルが自分で作る承認IDを許可根拠にしないでください。draftは検索に利用できません。新着や別バージョンを自動で共有対象に加えません。

CLIは、モデルに不要な本文をstdoutへ出さず、作成ファイルのパス・hash・件数だけを返します。HTMLは本文をエスケープし、スクリプト・外部リソースを使いません。プレビューは秘密性を保証するものではなく、人が共有可否を確認するためのものです。

## 検索・読取CLI

```bash
printf '%s\n' '{"action":"search","query":"memory","limit":5}' | \
  aistore --store /absolute/store --json knowledge --scope /absolute/private/sharing/scope.json

printf '%s\n' '{"action":"read","identity":"url:https://example.test/one","material_version":"EXACT_VERSION_FROM_SEARCH","offset":0}' | \
  aistore --store /absolute/store --json knowledge --scope /absolute/private/sharing/scope.json
```

応答は `protocol_version:1`、`result.ok/value/error`。業務エラーは終了0でも `ok:false` です。parse・起動エラーは非0。検索出力は16KiB以内、読取は64KiB以内・1ページ8,000 Unicode文字まで。`next_offset` と `truncated` を確認してください。

知識検索の既定はKagome/IPADICによる日本語解析です。ローカルの比較用に `--analysis lexical` / `--analysis japanese` と `--trace-analysis` があり、モデルの引数には公開しません。通常GUIの検索方式は変更していません。日本語解析の依存・配布条件は [第三者通知](</data/softwares/slack-intake/docs/third-party/knowledge-japanese-NOTICES.txt>) に記載し、ビルド時に実行ファイルへ添付します。

## DSH側

この版は新しいnative tool executorを提供するDSH master向けです。同じrc.3表記でも旧リリースとはAPIが異なるため、対象コミットを同梱のUPGRADE情報で確認してください。読取制限と実行拒否の方針は変更していません。

bundleは正規のPlugin Managerで導入します。既存のprofile設定ファイルを直接編集しません。新しい `intake-knowledge` presetだけを追加し、通常の会話や既存presetへツールを追加しません。

設定フィールド：

- `aistoreExecutable`：信頼されたGo CLIの絶対パス。
- `storeRoot`：固定した参照ストア。
- `scopeFile`：人が承認した共有scope。無ければ読取は失敗し、作成しません。
- `allowInertTeamTools`：既定false。Web共通拡張がAgent固有の協調ツール定義を挿入する環境だけでtrueにします。実行は許可しません。

同梱patchはこのマシンの既存ストア・CLI・ストア別管理領域を参照します。別環境では明示的に設定してください。scopeの不存在はツール登録を妨げませんが、資料は一切取得できません。

CLIはshellなし・固定argv・`LANG`だけの環境で起動します。15秒のtimeout、出力制限、取消時のプロセスグループ終了を持ちます。raw stderrはモデルへ返しません。試用Agentには継承ツールのallow mask、実行前の早期拒否、最終の実行guardを適用します。

厳密モードでは最終schemaが2ツールでない場合に作成を拒否します。Web互換モードでは、HostがAgent固有の層へ入れる既知の9個の協調ツール定義だけを追加で許容します。この層は公開の継承maskでは隠せないため、定義が見える場合がありますが、**実行可能なのはintakeの2ツールだけ**です。協調ツールはレビュー処理や本体を呼ぶ前に拒否し、それ以外の追加ツールが現れたら従来どおり作成を拒否します。他セッションのAgent Teamsは無効化しません。

## 検証

プロジェクトルートから：

```bash
node bin/knowledge-check.mjs
```

Go全体のtest/vet、隔離CLIビルド、合成資料とscope作成、Nodeの子プロセス制御、実DSH registry/Agentと実Go CLIの結合試験を行います。本番データや既存CLIバイナリを変更せず、モデル呼出しは0です。出力先はコマンドが表示するprivateな一時ディレクトリです。

`--unit` はCLI結合fixture作成を省略する開発用です。完全な検証結果とは区別します。

アイコンはこの機能向けのオリジナルSVGです。日本語・英語の表示情報を同梱します。
