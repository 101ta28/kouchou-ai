# 入力データガイド

広聴AIで扱うCSVは、自由記述コメントと、必要に応じた属性列で構成します。サンプルサイトでは「このCSVを入れると、このレポートが出て、それをこう読む」という対応関係を確認できるようにしています。

## 基本形

| 列 | 必須 | 内容 |
| --- | --- | --- |
| `id` | 推奨 | 回答や意見を識別するID |
| `comment` | 必須 | 分析対象の自由記述 |
| 属性列 | 任意 | 地区、年代、立場、提出経路など |

自由記述は、1行に1つの回答や意見を入れます。複数の論点が入っていても処理できますが、1つの行が長すぎる場合は、原文確認や政策論点の切り分けが難しくなります。

## 件数の目安

| ファイル | 件数 | 用途 |
| --- | ---: | --- |
| [small-10.csv](samples/test-data/small-10.csv) | 10 | 表示確認、手元での最小動作確認 |
| [medium-100.csv](samples/test-data/medium-100.csv) | 100 | 通常のサンプル検証、属性フィルター確認 |
| [large-1000.csv](samples/test-data/large-1000.csv) | 1000 | 大きめの入力での処理確認 |

## 属性列の例

| ファイル | 確認できること |
| --- | --- |
| [multiple-attributes.csv](samples/test-data/multiple-attributes.csv) | 地区、年代、世帯構成、交通手段、提出経路、優先度など複数属性の扱い |
| [special-characters.csv](samples/test-data/special-characters.csv) | カンマ、引用符、改行、多言語、記号を含むコメントの扱い |

属性列は、レポートを読んだ後に「どの層から出ている論点か」を確認するために使います。個人を特定できる情報、自由記述内の氏名、連絡先、具体的な住所、未公開情報は入れないでください。

## ネガティブテスト用CSV

以下は、エラー処理や取り込み不可ケースの確認に使うための無効なCSVです。通常の分析には使いません。

| ファイル | 内容 |
| --- | --- |
| [invalid/unclosed-quote.csv](samples/test-data/invalid/unclosed-quote.csv) | 引用符が閉じていないCSV |
| [invalid/missing-comment-column.csv](samples/test-data/invalid/missing-comment-column.csv) | `comment` 列がないCSV |
| [invalid/inconsistent-columns.csv](samples/test-data/invalid/inconsistent-columns.csv) | 行ごとの列数が不一致のCSV |

## サンプルCSVの再生成

テスト用CSVはスクリプトで再生成できます。

```bash
node apps/public-viewer/scripts/generate-sample-csvs.mjs
```

生成先は `apps/public-viewer/public/samples/test-data/` と `docs/use-cases/samples/test-data/` です。
