# 閲覧専用サンプルサイトを Vercel にデプロイする

`apps/public-viewer` は、環境変数 `NEXT_PUBLIC_SAMPLE_SITE=true` を設定すると、APIに接続せずに同梱されたサンプルレポートを表示します。

この構成は、公開事例や利用イメージを見せるための閲覧専用サイト向けです。CSVアップロード、レポート生成、APIキー入力、admin操作はできません。

## Vercel 設定

モノレポのまま、Vercel Project の Root Directory を以下に設定します。

```text
apps/public-viewer
```

環境変数を追加します。

```text
NEXT_PUBLIC_SAMPLE_SITE=true
```

Vercel の通常の Next.js デプロイとしてビルドします。`NEXT_PUBLIC_OUTPUT_MODE=export` は設定しません。

## サンプルを追加する

サンプルを追加する場合は、主に以下を編集します。

| ファイル | 役割 |
| --- | --- |
| `apps/public-viewer/app/sample-site/catalog.json` | レポート一覧、ユースケース説明、クラスタ、コメント |
| `apps/public-viewer/public/samples/*.csv` | viewer側で配布するサンプルCSV |
| `docs/use-cases/*.md` | ドキュメントサイト上のユースケース説明 |
| `docs/use-cases/samples/*.csv` | ドキュメントサイト側で配布するサンプルCSV |

サンプル内容はTypeScriptに直接埋め込まず、JSONとCSVで管理します。コード側の `data.ts` は、JSONをviewerの `Result` 型に変換する薄い層です。

## ローカル確認

```bash
cd apps/public-viewer
NEXT_PUBLIC_SAMPLE_SITE=true next build
NEXT_PUBLIC_SAMPLE_SITE=true next dev
```
