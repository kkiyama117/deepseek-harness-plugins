# deepseek-harness-plugins

[English](README.md) | 日本語

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)向けの非公式プラグイン、ローカルフォーク、プリセット、スキル、保守ツールです。単体でインストールできる1つのプラグインではなく、DSHの配布物でもありません。ソースを集めたリポジトリです。

## 目次

- [リポジトリの構成](#リポジトリの構成)
- [互換性](#互換性)
- [プラグインとプリセット](#プラグインとプリセット)
- [スキル](#スキル)
- [インストール](#インストール)
- [開発](#開発)
- [リポジトリの公開範囲と管理](#リポジトリの公開範囲と管理)
- [ライセンス](#ライセンス)

## リポジトリの構成

以下のディレクトリはどれもソースの置き場で、配備の一覧ではありません。クローンしても何もインストールされず、何も有効になりません。

| パス | 内容 |
|---|---|
| [plugins/](plugins/) | プラグインのソース、ローカルフォーク、参考として残している実装を、コンポーネントごとに1ディレクトリで置いています。[plugins/dsh-web-ui/packages/](plugins/dsh-web-ui/packages/)は入れ子のパッケージ構成のままです。 |
| [presets/](presets/) | エージェントプリセットの宣言です。プリセットごとにマニフェストとCordisパッチを置きます。プリセットを宣言しても、その行が指すパッケージはインストールされません。 |
| [configs/](configs/) | 設定だけのバンドルとサービス設定で、実行時のコードは含みません。詳しくは[このディレクトリのREADME](configs/README.md)を参照してください。 |
| [skills/](skills/) | 自作したスキルとupstream由来の複製を、スキルごとに1ディレクトリで置いています。 |
| [bin/](bin/) | パッケージのビルド・梱包・検査を行う保守用スクリプト、週次保守の補助スクリプト、[配置検査](bin/runtime-placement.md)のメモです。公開CLIではありません。 |
| [scripts/](scripts/) | 読み取り専用の[ローカル設定の診断](scripts/local-setup.mjs)です。 |
| [tests/](tests/) | パッケージ内に置かないVitestの設定と、アップグレードの回帰テストです。 |
| [docs/](docs/) | [レイアウト移行](docs/layout-migration.md)と[保守対象と保管対象](docs/maintenance-scope.md)のメモです。 |
| [.agents/](.agents/) | このリポジトリの開発で使うメモと、harness側のスキルです。 |

ローカルの作業コピーには、ignoreされた`reports/`、`releases/`、`local-design/`などのディレクトリもあります。いずれも私的な資料を含み、公開しているツリーの一部ではありません。

**レイアウト移行:** 既存のインストール、プロファイル、systemdユニット、スクリプトは、旧来のリポジトリ直下のパスをまだ参照しているかもしれません。このリポジトリのソースを移動しても、それらは更新されません。稼働中のチェックアウトを置き換える前に、参照を洗い出して移行してください。残しているSlack workerの設定と互換用のパッチには、マシン固有のパスが含まれるため、他の環境で使う前に確認が必要です。切り離したチェックアウトや、ソースのテストが通ったことを、稼働環境の移行が済んだ証拠にしないでください。手順は[移行チェックリスト](docs/layout-migration.md)を参照してください。

## 互換性

導入するパッケージを個別に選び、そのREADMEを読んでから使ってください。パッケージごとに対象のDSHリリースが異なり、このリポジトリにあるからといって、手元のバージョンで動くとは限りません。

- [DSH Evolve](plugins/dsh-evolve/README.md)は、DSH `0.2.1-rc.3`とNode.js `>=24.9.0`を前提としています。
- [Prompt Compact](plugins/dsh-prompt-compact/README.md)はDSH `0.2.1`を対象とし、レビューした版と指紋が一致するupstreamのプロンプト文だけを置き換えます。
- リポジトリ直下の[pnpmワークスペース](pnpm-workspace.yaml)は、DSH `0.1.0-rc.8`系の開発依存を残しています。そのビルドとテストは、リポジトリ全体の互換性検査ではありません。
- 古いアダプタは、パッケージごとに要件が異なります。特にWeb SearchとCursorのinvariant companionは、現在のDSH masterには無いレジストリに依存します。古いインストール例を、現行版の手引きとして扱わないでください。

[保守対象と保管対象](docs/maintenance-scope.md)では、保守している拡張、参考として残している実装、削除したmanaged providerを区別しています。`managed-standard`と`managed-cordis`というプリセット名は、削除済みのproviderを使っていることを意味しません。

## プラグインとプリセット

以下は各コンポーネントの導入方法、動作、制約をまとめたものです。すべてを入れる一覧ではありません。

| コンポーネント | 目的 |
|---|---|
| [DSH Evolve](plugins/dsh-evolve/README.md) | ツールの失敗と繰り返しの呼び出しを観測します。インストール時はLLM呼び出しを行わない観測モードが既定で、提案の生成はオプトインです。有効化とロールバックは人のコマンドで行います。 |
| [Prompt Compact](plugins/dsh-prompt-compact/README.md) | WorkflowとRalphのプロンプト節に対する、プリセット単位のオプトインの代替です。ツールのスキーマと実行の挙動は変わらず、Cordis Skillも登録しません。 |
| [Goal acceptance](plugins/dsh-goal-acceptance/README.md) | 元の依頼を保持し、Goalの完了判定と最初の委任について証拠の記録を確認します。共有Hostで有効にする前に、[限定運用のpilot](plugins/dsh-request-acceptance-pilot/README.md)を読んでください。 |
| [Workflow result selection](plugins/dsh-workflow-results/README.md) | `resultKeys`で選んだフィールドを返す前に、ワークフローの結果全体を保存します。選んだプリセットでツールの置き換えが必要です。 |
| [Codex transport recovery](plugins/dsh-codex-transport-recovery/README.md) | 特定の早期WebSocket切断を通信エラーとして分類し、公式の再試行方針で扱えるようにします。再試行の追加やモデルの変更はしません。 |
| [AI reference-store daily preset](presets/ai-reference-store-daily/README.md) | 別に設定する参照ストア・アプリケーション向けのプリセットを宣言します。プリセットを選んでも日次バッチは始まりません。 |

古い連携とローカルフォーク:

| コンポーネント | 目的 |
|---|---|
| [Web Search](plugins/dsh-web-search/README.md) — `@kkiyama117/dsh-web-search` | [pi-web-access](https://github.com/nicobailon/pi-web-access)から移植した、キー不要のDuckDuckGo HTML検索です。 |
| [Cursor adapter](plugins/dsh-llm-cursor/README.md) — `@kkiyama117/dsh-llm-cursor` | harnessのモデル呼び出しごとにCursor SDKのagentを実行し、replay stateでセッションを継続します。 |
| [Web UI family](plugins/dsh-web-ui/packages/) | UI、SSH、Git graph、設定、Modlensの各パッケージのローカル複製です。それぞれのREADMEを参照してください。 |
| [Market](plugins/dsh-market/README.md) | 独自のビルドと互換性検査を持つ、プラグインマーケットのローカル複製です。 |

## スキル

[skills/](skills/)にあるのは、自作したスキルとupstream由来の複製です。クローンしただけではインストールも有効化もされません。ローカルの配備先では、スキルのディレクトリをDSHのスキル探索パスへリンクすることがあります。その場合は複製した別の版ではなく、ソースのディレクトリを編集してください。有効にする前に、各スキルの前提を読んでください。

| スキル | 目的と前提 |
|---|---|
| [issue-driven-development](skills/issue-driven-development/SKILL.md) | Issueの受け付け、機能追加とbugfixの実施、検証、開発手順の改善を、人間とAI agentが同じ手順で進めます。このリポジトリの設定は[開発への参加](CONTRIBUTING.md)を参照してください。 |
| [orchestrate-agents](skills/orchestrate-agents/SKILL.md) | タスクの整理、直接実行と委任の使い分け、範囲を限ったオーケストレーションです。[実行上の制限](skills/orchestrate-agents/README.md)も参照してください。 |
| [archify](skills/archify/SKILL.md) | [archify](https://github.com/tt-a1i/archify)のローカルフォークです。アーキテクチャを可視化し、1920×1080と2048×1320でスクリーンショットを確認します。 |
| [quint-lang](skills/quint-lang/SKILL.md) | Quintの構文とCLIのリファレンスです。[quint-llm-kit](https://github.com/quint-co/quint-llm-kit)から取り込みました。 |
| [quint-modeling](skills/quint-modeling/SKILL.md) | 要件やソースコードからQuintの仕様を書く、またはレビューします。 |
| [quint-execute-spec](skills/quint-execute-spec/SKILL.md) | 既存のQuint仕様に沿ってコードを実装します。 |
| [quint-cli](skills/quint-cli/SKILL.md) | コンテナを使うQuint CLIの手順です。記載のコンテナツールとイメージが必要です。 |
| [quint-verify](skills/quint-verify/SKILL.md) | invariantとwitnessの検査を実行し、構造化した検証レポートを作ります。記載のQuintコンテナ環境が必要です。 |
| [slack-reference-intake](skills/slack-reference-intake/SKILL.md) | 別に設定した私的なGo aistore向けの参照取り込みです。許可されたSlackアクセスとDSHの認証情報を使います。単体で動く公開デモではありません。 |
| [implement-task](skills/implement-task/SKILL.md) | [Quint仕様](skills/implement-task/spec/README.md)付きで残している実装フローの参考資料です。旧`subagent-fallback`のツールに依存するため、現在のDSHで使う前に、呼び出し側と仕様を移行してください。 |

## インストール

1. DSHを別途インストールし、対象のプロファイルを選びます。
2. 選んだパッケージのREADME、マニフェスト、パッチで、DSHとの互換性、前提、有効になる範囲を確認します。ビルドが必要なパッケージは、読み込む前にパッケージ自身の開発手順でビルドしてください。
3. 選んだバンドルだけをDSHのPlugin Managerかplugin CLIでインストールします。バンドルはパッケージのマニフェストで`dsh.bundle.patch`を宣言します。リポジトリのルートや、そのままのスキルのディレクトリはバンドルではありません。
4. パッケージごとのオプトインの手順を済ませます。たとえばPrompt Compactはバンドルのパッチが空なので、自分で書いたプリセットに行を追加する必要があります。DSH Evolveは逆に、インストールすると観測モードでマウントされます。

DSHのソースチェックアウトからCLIを使う場合:

```sh
pnpm dsh plugin --help
```

古い例に書かれているメンテナのファイルシステム上のパスではなく、自分のパッケージの場所を使ってください。プロファイルへの導入は、upstreamの[バンドル公開の手引き](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)を参照してください。これらの拡張を有効にするために、DSHに同梱のプリセットを書き換えないでください。

## 開発

不具合の報告や改善の提案は[Issues](https://github.com/kkiyama117/deepseek-harness-plugins/issues)へお願いします。[CONTRIBUTING.md](CONTRIBUTING.md)に、人間とAI agentが共有する開発の流れと、このリポジトリの検証と公開範囲を書いています。

リポジトリ直下の[パッケージマニフェスト](package.json)は、pnpmを`11.7.0`に固定しています。リポジトリ直下のワークスペースに入っているのはWeb Search、Cursor、Web UI系の5パッケージで、このリポジトリの全パッケージではありません。

| リポジトリ直下のコマンド | 範囲 |
|---|---|
| `pnpm install` | リポジトリ直下のワークスペースの依存を、そのロックファイルでインストールします。 |
| `pnpm build` | 各ワークスペースメンバーのビルドスクリプトを実行します。ビルドはすべて素の`tsc`ではなく、UIのパッケージはclientのアセットもバンドルします。 |
| `pnpm test` | ワークスペースメンバーのテストスクリプトを、ワークスペースの並列度1で実行します。 |

そのワークスペースに入っていないパッケージは、それぞれのREADMEとパッケージのスクリプトに従ってください。リポジトリ直下のビルドやテストが通ったことを、それらのパッケージが手元のDSHで動く証拠にしないでください。ビルドが必要なパッケージが読み込むのは生成物であり、編集したソースではありません。パッケージの再ビルドと再読み込みの手順に従ってください。

読み取り専用の[ローカル設定の診断](scripts/local-setup.mjs)は、ローカルのDSHプロファイルを調べます。`plugins/dsh-market/lib/check.js`をimportするため、リポジトリ直下のワークスペース外にあるビルド済みのMarketパッケージが必要です。クローン直後に実行する設定コマンドでも、インストーラでもありません。

## リポジトリの公開範囲と管理

このリポジトリが公開するのは、プラグイン、プリセット、スキル、テスト、保守ツールのソースです。認証情報、私的な設計・レビュー資料、実行レポート、配備の一覧、ローカルキャッシュ、リリースアーカイブはGitの外に置きます。コミットする前に、新しいファイルへ機密情報が無いか確認してください。ignoreの設定は、秘密情報を検出する仕組みではありません。

公開履歴はソースのみのスナップショットから始まり、それ以前のローカル履歴はここにはありません。構成と検証の限界は[アーキテクチャ](ARCHITECTURE.md)、upstreamのCore基準とレビュー済みの例外は[ソース管理の方針](SOURCE-OWNERSHIP.md)を参照してください。

## ライセンス

[MIT](LICENSE)。取り込んだコード、フォーク、スキルに含まれるupstreamのライセンス表記と帰属表示は保持してください。
