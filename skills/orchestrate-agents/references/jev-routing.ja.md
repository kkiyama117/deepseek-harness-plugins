# Jevによる工程の振り分け

このskillの任意利用の入口です。既存の工程情報から必要なChoice質問だけをまとめてJevへ送り、固定ルールで進め方を選びます。会話ごとの自動フックではありません。既存のtask packetや作業単位を入力し、必要なら既存コンパイラのworkflow入力を生成します。新しいエージェント実行器や分割設計器は追加しません。

## まず外部送信なしで確認する

skillディレクトリで、親ディレクトリが存在する新しい出力先を指定します。

```sh
node bin/route.mjs examples/routing-stage.json examples/routing-policy.json /ABSOLUTE/PRIVATE/new-routing
```

例は合成データです。確定済みの値だけでF1を選ぶため、APIキーも通信も不要です。既定の`shadow`では判定案と引継ぎを記録するだけで、実行可能なworkflow入力は出しません。例のモデル`fixture/synthetic-only`は実際の利用先ではありません。

## 入力を分ける

- **工程（STAGE）**：`requestId`、`stageId`、`sourceRevision`、未完了の成果`remainingGoals`、既存形式の`task`と`units`、各unit IDの依存先配列`dependencies`を指定します。`task.goal`と`acceptance`は現在の工程のものです。工程完了を依頼全体の完了と扱いません。
- **分担候補**：`division`は`ready`（既存の独立候補あり）、`none`（分担候補なし）、`needs_design`（新たな分割設計が必要）です。`ready`でも2単位以上、依存先が空、書込み競合がないことを確認します。任意の文章から候補を自動生成しません。新たな設計が必要なら通常の担当判断へ戻します。
- **運用方針（ROUTING_POLICY）**：`stageAuthorized`は工程の実施許可、`externalSend`はこの最小入力をTypeSafeへ新規送信する許可、`workflowAuthorized`は明示的に要求されたworkflowの許可です。別々に設定し、Jevの回答から許可を作りません。既存の実行方針は`execution`、並列度と修正回数は`options`に入れます。
- **確定済みの事実**：`facts`には運用者が確認した`readiness`、`routine_fit`、`separability`、`delegation_value`のみを指定します。Jevへ聞くためだけに詳細計画を作る必要はありません。自由なモデル出力をこの欄へコピーして採用閾値を迂回しないでください。
- **定型手順**：方針側の`routines`にIDごとの`description`と`eligible`を登録し、工程側の`routineCandidates`で候補IDを指定します。`eligible:true`は運用者が手順の存在、入力条件、許可範囲を確認したことを表します。コマンドを生成・実行する欄ではありません。
- **明示指定**：`explicit.flow`は`direct`、`single`、`lead-workers`、`F0`、`F2`。`explicit.models`はroleから`{provider,model}`への対応です。指定があればJevで追認せず、方針に一致しないモデルを置換しません。通常flowは`facts.readiness:ready`、F2は`investigate`の事前確認が必要です。モデルだけの指定や対応外のflowは通常判断へ戻します。

## 質問と選択

質問は現在の工程について1リクエストにまとめます。定型候補がなければ`routine_fit`を、既存の分担候補がなければ分担の2問を送りません。確定した値も再質問しません。

| 質問 | 選択肢 |
|---|---|
| `readiness` | `ready` / `investigate` / `needs_input` / `unknown` |
| `routine_fit` | 登録済み候補ID / `none` / `unknown` |
| `separability` | `together` / `research` / `work` / `unknown` |
| `delegation_value` | `worthwhile` / `small` / `unknown` |

| 結果 | 接続先 |
|---|---|
| F0 / R5 | 登録済み手順の引継ぎ。シェルを実行しない |
| F1 / R8 | 直接作業の引継ぎ。workflow許可があれば既存`single` |
| F2 / R4 | 範囲を限定した調査の引継ぎ。既存テンプレートの名前ではない |
| F3 / R6 | 独立した読取り調査。workflow許可があれば既存`lead-workers` |
| F4 / R7 | 独立作業。同じく既存`lead-workers` |
| `hold` / R2 | 許可または利用者判断が必要 |
| `fallback` / R3 | 通常の担当判断へ戻す。別モデルを自動で呼ばない |

F2には`investigation:{question,target,exitCriteria,maxSteps}`が必要です。戻り先の工程と残る成果を保持します。同じ入力の調査案を前回記録に続けて出そうとした場合は、追加証拠待ちのfallbackにします。`maxSteps`は引継ぎ先が守る制約であり、この入口が調査を実行・監視するわけではありません。

F3/F4の`lead-workers`は計画、各worker、統合、レビューを含みます。単純な最小fanoutではなく、その呼出し数も既存コンパイラが検査します。workflow未許可なら新しい実行器は使わず通常判断へ引き継ぎます。その場合も候補のscope、role、予算を同じコンパイラで検査します。scopeは宣言の検査であり、サンドボックスやsymlinkの隔離保証ではありません。

## API利用と選択モード

新規分類を許可する場合だけ`externalSend:true`にします。`gateway`で次の接続先を明示できます。省略時は`typesafe`です。キーを入力JSONやコマンド引数に書かないでください。任意のURL、リダイレクト、接続先間の自動切替は認めません。

| gateway | 固定の送信先 | 環境変数 | model |
|---|---|---|---|
| `typesafe` | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` | `jev-1.13.0`などの版付きID |
| `openrouter` | `https://openrouter.ai/api/alpha/decisions` | `OPENROUTER_API_KEY` | `~typesafe/jev-latest`または`typesafe/jev-1.13` |

OpenRouterはチャットAPIではなくDecisions APIを使います。日付付きのモデル名を設定せず最新を使うには、既存方針の`gateway`を`openrouter`、`model`を`~typesafe/jev-latest`にします。先頭の`~`が必要です。返答は具体的な版のJevモデル名とprovider=`TypeSafe`であることを確認し、その実モデル名を記録します。返答までlatest名のまま、または別系列のモデルなら採用しません。

版を固定したい場合は`typesafe/jev-1.13`を選びます。この場合は公開情報に基づく`typesafe/jev-1.13-20260917`との一致を確認します。固定指定からlatestへの自動切替はしません。どちらも要求の`provider.allow_fallbacks`は`false`です。

返答の全選択肢の確率、confidence、使用token数を検査します。OpenRouterの仕様では確率・confidenceが省略可能でも、このルーターは安全な採用判定のため両方を必須とします。返されたID・provider・費用も記録します。両gatewayを混ぜたキャッシュ再利用は行いません。

`mode:"select"`と`thresholds`を明示した場合だけ実行可能なworkflow入力を出します。`thresholds`は質問IDから0〜1の採用基準への対応で、採用するモデル回答のconfidenceと選ばれた確率の両方に適用します。使わない質問の閾値や不明値は、既に決まった選択を妨げません。全て確定済みなら空オブジェクトで構いません。実タスクで質問ごとに評価した基準を運用者が指定してください。テストの0.7は合成値で、安全性の保証でも推奨値でもありません。

`limits`は`maxCalls`（分類呼出し数）、`maxInputBytes`（新規送信本文の累積バイト数）、`maxRequestBytes`、`maxResponseBytes`、`timeoutMs`です。全て有限整数で、タイムアウトは正数です。初期版は再試行・別providerへの切替なしです。これらは金額上限ではなく、返答token数の課金保証もしません。外部APIを使う前に送信範囲と料金を別途確認してください。

## 記録、再利用、実行

出力先は排他的に作成する0700ディレクトリ、ファイルは0600です。`report.json`に工程、定義版、ルール、提案flow、呼出し量、cache、正規化した返答を残します。新規送信時は`classification-request.json`を通信前に保存します。保存失敗なら送信しません。`classification-response.json`は検査済みの返答です。認証ヘッダやAPIの生エラー本文は保存しません。実データはskill外の私有ディレクトリへ置き、秘密情報や会話全文を工程情報に含めないでください。

同じ作業の次の判定では前回のreportを必ず渡します。

```sh
node bin/route.mjs /PRIVATE/stage.json /PRIVATE/routing-policy.json /PRIVATE/new-report /PRIVATE/previous/report.json
```

固定モデルでは、工程、入力版、成果、候補、依存関係、質問、確定事実、モデル版、定義版が一致すれば分類を再利用します。JSONのキー順だけの違いは無視します。cacheは構造を再検査し、実施許可と実行予算も毎回確認します。外部送信許可が取り消されても、送信のない有効cache再利用は可能です。失敗したAPI呼出しも使用量に含め、許可待ちや明示指定の記録にも累積量を引き継ぎます。

`~typesafe/jev-latest`では、同じ名前でも中身の版が変わるため、判定キャッシュを再利用しません。`cachePolicy:no-reuse-for-latest`と記録し、分類が必要なら毎回1回の新規呼出しを行います。外部送信禁止なら、古い判定を代用せずfallbackにします。使用量の累計は引き継ぐため、latestでも前回のreportを渡してください。

latestの選択はモデル更新への追随を許可する指定です。異なる版で同じ採用閾値の精度が保たれる保証はありません。再現性や校正済み閾値を優先する場合は固定モデルを使ってください。

上限は渡されたreportの系列に対して有効です。共有課金台帳ではなく、複数プロセスやreportを省いた呼出しを横断して制限しません。前回記録を省略・改変して上限を回避しないでください。強制終了でrequestだけ残った場合、送信や課金があったかは不明です。自動再実行せず、記録と使用量を確認してください。

`status:compiled`かつ`executable:true`のときだけ、`routed-request.json`と既存コンパイラが生成した`tool-input.json`を出します。実行する前に現時点の許可を再確認し、[DSH実行手順](run-dsh.md)に従ってそのままnative `workflow`へ渡します。保存済み入力は永久的な許可ではありません。生成器はworkflowを提出せず、完了も宣言しません。`shadow`には実行scriptがなく、`fallback`・`hold`・取消は成功ではありません。

## 検証範囲

`tests/routing.test.mjs`と`tests/openrouter.test.mjs`はHTTPをmockし、F0〜F4、認可、単一リクエスト、cache、取消、サイズ・回数制限、返答不正、compilerへの接続、fake agentでの生成script実行、gatewayごとの認証・モデル照合を確認します。

OpenRouterの実APIでは、固定モデルの正常応答とcache再利用、latestの正常応答とcache非再利用を、同じ合成データで確認しました。[試験記録](openrouter-verification.md)は、先行した失敗も含めて記載しています。分類精度の一般評価や費用削減の比較試験ではありません。TypeSafe直接接続の実APIは未検証です。

再試験する場合、`OPENROUTER_API_KEY`を設定して次を実行します。1回だけ有料APIを呼び、追加のcache方針確認は外部送信しません。latestでは再利用されないことを確認します。モデル引数を省くと固定モデルの試験になります。

```sh
node bin/smoke-openrouter.mjs --live /ABSOLUTE/PRIVATE/new-smoke '~typesafe/jev-latest'
```

承認済みのowner-only環境ファイルから渡す場合は、`uv run --no-project bin/run-openrouter-smoke.py --live --key-file /APPROVED/secrets.zsh --model '~typesafe/jev-latest' /ABSOLUTE/PRIVATE/new-smoke`を使えます。単一のリテラル`OPENROUTER_API_KEY`代入だけを読み、shellとして実行しません。キーは子プロセスの環境にだけ渡します。

仕様の出典：[TypeSafe API](https://docs.typesafe.ai/api.md)、[モデル一覧](https://docs.typesafe.ai/models.md)、[OpenRouter Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request.md)、[Jevの公開endpoint情報](https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints)。
