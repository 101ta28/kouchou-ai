# 広聴AI 監査資料ビューア

監査ZIPをローカルで閲覧・検証する、独立した単一HTMLアプリです。広聴AIのAPIやPython、ログイン、インターネット接続は不要です。

## 開く

配布ZIPを展開し、ルートの `index.html` をブラウザで開きます。「資料AのZIP」で取得した公開監査資料を選び、「資料を検査する」を押してください。「架空のサンプルを開く」で、実際の個人情報を使わず操作を試せます。

署名を確認する場合は「署名・別経路のハッシュを確認する」を開き、発行者と指紋を別途確認した公開鍵を指定します。ビューアは公開鍵の提供元の身元や現在の失効状況を自動確認しません。内部記録は「内部監査」を明示的に選んだ場合だけ読み込みます。

## ソースからビルド

Node.js 22.17以降が必要です。ビルドと検証ライブラリは追加パッケージを必要としません。

```bash
node apps/audit-viewer/build.mjs
```

- `apps/audit-viewer/dist/index.html`：単独で使えるビューア
- `apps/audit-viewer/dist/audit-viewer.zip`：ビューア、ソース、仕様、検証用資料、ライセンスを含む配布用ZIP
- `apps/audit-viewer/dist/SHA256SUMS`：配布ファイルの同一性を照合するハッシュ

同じソース・仕様・サンプルからは同じHTMLを生成します。配布元を確認するには、ハッシュ自体も別の信頼できる経路で取得してください。

## 検証

```bash
node --test --experimental-test-isolation=none packages/audit-verifier/tests/*.test.mjs
node apps/audit-viewer/build.mjs
node --test --experimental-test-isolation=none apps/audit-viewer/tests/*.test.mjs
```

ブラウザテストにはルートの開発依存である `@playwright/test` とChromiumが必要です。開発環境では `pnpm install --frozen-lockfile` と `pnpm exec playwright install chromium` で準備します。ビューア利用者には不要です。日本語の表示確認にはOSの日本語フォントも必要です。

詳しい操作・鍵管理・第三者への受け渡しは [独立監査の運用手順](../../docs/development/independent-audit.md)、別の検証ツールを作る場合は [形式仕様](../../packages/audit-verifier/FORMAT.md) を参照してください。
