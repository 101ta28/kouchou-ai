# 検証用の架空データ

すべて架空の資料です。実際の政策分析や監査結果ではありません。

- public-valid.zip: ファイルのハッシュ一致、署名なし
- public-second.zip: 別の実行。workers が2から3へ変化
- public-tampered.zip: audit.jsonを変更し、元のmanifest.jsonを保持。ハッシュ不一致
- public-missing.zip: audit.json欠落
- internal-example.zip: 入力1ファイルはハッシュ検査、残り3ファイルはサイズのみ検査

公開資料は実際のPythonエクスポーターで生成し、ZIPの日時だけを固定しています。
