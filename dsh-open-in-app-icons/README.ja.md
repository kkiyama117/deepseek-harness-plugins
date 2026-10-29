---
description: "DSH Coreとアプリ起動処理を変更せず、指定アプリに汎用アイコンを提供します。"
kind: "package-bundle"
---

# @local/dsh-open-in-app-icons

[English](README.md) | 日本語

## 概要

このbundleは、この環境で取得できないアプリアイコンのURLに、ブラウザがキャッシュできる汎用画像を提供します。初期の対象は `filemanager`、`cursor`、`vscode` です。既存のブラウザ認証、アプリ一覧、起動処理、他のアイコンURLは変更しません。ブラウザコードの追加やCoreファイルの変更はありません。

## 目次

- [利用方法](#利用方法)
- [実装](#実装)
- [モデルへの影響](#モデルへの影響)
- [制約](#制約)

## 利用方法

検証済みの配布アーカイブを、Plugin Managerの `action: install_bundle` と、`target` に指定する絶対パスで対象profileに導入します。追加する行は `local-open-in-app-icons` だけで、公式プラグインの無効化や置換はしません。Plugin Managerでbundleを無効にすると、そのルートを解除します。取得済みの画像は、キャッシュ期間が切れるまでブラウザに残る場合があります。

対象の指定は [cordis.patch.yml](cordis.patch.yml) にあります。`applicationIds` は重複しない小文字のアプリIDを1件以上指定する必須項目です。`cacheMaxAgeSeconds` は0以上の整数を指定する必須項目で、付属の設定では3600秒です。profileから上書きする場合、config全体が置換されるため両項目を指定します。

認証済みのGETで、指定した完全一致パスにアクセスした場合だけ、SVGを200で返してブラウザの私有キャッシュを許可します。認証・信頼判定での拒否は401または403、GET以外は405のままです。未指定のパスは公式実装が応答し、不明なアイコンIDや取得できない変更要約の404は変更しません。

## 実装

[Hostプラグイン](index.mjs) は公開APIの `webServer.register` で完全一致ルートを登録します。完全一致は既存のアイコン用prefixルートより優先されます。画像を返す前に、既存の `connection.requestRejection` で認証を確認します。登録はContextのeffectが所有し、アンロード時にすべて解除します。不正な設定、IDの重複、付属画像の欠落、完全一致ルートの競合は有効化時の失敗として報告します。

[SVG](assets/fallback.svg) はDSHの既存の `right-up-outline` 図形を再利用し、[MITライセンス](LICENSE) を同梱します。明暗どちらの背景でも見える中間の灰色を使った独立画像で、アプリ固有のロゴではありません。

ソースの回帰試験は `uv run --no-project bin/test.py` で実行します。`--package /absolute/path/to/unpacked/package` を付けると、同じ試験を展開済み配布物に対して実行します。実際のCordis Loader、WebServer、公式open-in-app実装を読み込み、デスクトップ情報と認証は固定した試験入力を使います。稼働中のブラウザでの確認は導入後に別途行います。

## モデルへの影響

ありません。モデル用ツール、指示、Sessionイベントを追加しません。

### トークンへの影響

ありません。

### KV Cacheへの影響

ありません。

## 制約

指定したURLは、後から実アイコンが取得可能になっても汎用画像を返します。公式のアイコン探索に戻す場合は、そのアプリIDを設定から外して再読み込みします。アイコン欠落の自動検出、アプリの利用可否の変更、desktop entryの作成、変更要約の永続化、Consoleエラーの抑制は行いません。manifestでは検証済みのDSHバージョンだけで有効化を許可し、対象を広げる前に互換性を検証します。
