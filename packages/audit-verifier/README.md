# 独立した監査検証ライブラリ

分析コア・API・Pythonから独立した、外部依存のないJavaScript実装です。ビューアは同じコードを単一HTMLへ組み込みます。Node.js 22.17以降でも実行できます。

```bash
node packages/audit-verifier/bin/audit-release.mjs verify public-audit.zip
node packages/audit-verifier/bin/audit-release.mjs verify signed-audit.zip --public-key confirmed-public-key.pem
node packages/audit-verifier/bin/audit-release.mjs verify internal-audit.zip --internal
```

終了コード0は、指定したファイル検査に不一致がなかったことを示します。署名なし・サイズのみの検査は、結果の各項目で区別します。`--public-key` を指定した場合は、その鍵による署名確認も成功条件です。原文の正確性や公平性の判定ではありません。

[形式仕様](FORMAT.md) と [検証用の架空データ](fixtures/README.md) を使って、別の実装で確認できます。署名作成と静的な公開資料集の生成は [運用手順](../../docs/development/independent-audit.md) を参照してください。秘密鍵はブラウザや配布ZIPに含めません。
