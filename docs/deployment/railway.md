# Railway デプロイ手順

この手順は、Supabase Auth を有効にしたマルチユーザー構成を Railway で動かすためのものです。

## 構成

Railway では同じ GitHub リポジトリから、次の3つの Web サービスを作成します。

| サービス | Dockerfile path | 公開 |
| --- | --- | --- |
| `api` | `apps/api/Dockerfile` | する |
| `admin` | `apps/admin/Dockerfile` | する |
| `public-viewer` | `apps/public-viewer/Dockerfile` | する |

Railway は公開 Web サービスに `PORT` を渡します。各コンテナは `0.0.0.0:$PORT` で待ち受ける必要があります。

## 事前準備

1. Supabase プロジェクトを作成します。
2. Supabase Auth の Email/Password を有効にします。
3. `supabase/migrations/` の migration を Supabase に適用します。
4. platform owner を `public.platform_owners` に追加します。
5. Railway に GitHub リポジトリを接続します。

## Railway サービス設定

各 Railway サービスで同じリポジトリを Source に指定し、Service Settings の Dockerfile path をそれぞれ設定します。

`api`:

```text
apps/api/Dockerfile
```

`admin`:

```text
apps/admin/Dockerfile
```

`public-viewer`:

```text
apps/public-viewer/Dockerfile
```

## 環境変数

値に URL が必要なものは、Railway で各サービスの Public Domain を発行してから設定してください。

### `api`

```env
AUTH_ENABLED=true
ENVIRONMENT=production
WITH_GPU=false

ADMIN_API_KEY=<random-admin-api-key>
PUBLIC_API_KEY=<random-public-api-key>
OPENAI_API_KEY=<openai-api-key>
GEMINI_API_KEY=

SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_JWKS_URL=https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
SUPABASE_JWT_ISSUER=https://<project-ref>.supabase.co/auth/v1
SUPABASE_JWT_AUDIENCE=authenticated
SUPABASE_SERVICE_ROLE_KEY=<server-only-service-role-key>

NEXT_PUBLIC_SITE_URL=https://<public-viewer>.up.railway.app
REVALIDATE_URL=https://<public-viewer>.up.railway.app/api/revalidate
REVALIDATE_SECRET=<random-revalidate-secret>
RETENTION_DAYS=30

# Railway Volume mount path を /app/storage にした場合
REPORT_DIR=/app/storage/outputs
CONFIG_DIR=/app/storage/configs
INPUT_DIR=/app/storage/inputs
DATA_DIR=/app/storage/data
```

`SUPABASE_SERVICE_ROLE_KEY` は `api` だけに設定します。`admin` と `public-viewer` には設定しないでください。

### `admin`

```env
AUTH_ENABLED=true
NEXT_PUBLIC_AUTH_ENABLED=true

NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<supabase-anon-or-publishable-key>

NEXT_PUBLIC_API_BASEPATH=https://<api>.up.railway.app
API_BASEPATH=https://<api>.up.railway.app
NEXT_PUBLIC_ADMIN_API_KEY=<same-as-api-ADMIN_API_KEY>

NEXT_PUBLIC_CLIENT_BASEPATH=https://<public-viewer>.up.railway.app
CLIENT_STATIC_BUILD_BASEPATH=https://<public-viewer>.up.railway.app
```

### `public-viewer`

```env
AUTH_ENABLED=true
NEXT_PUBLIC_AUTH_ENABLED=true

NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<supabase-anon-or-publishable-key>

NEXT_PUBLIC_API_BASEPATH=https://<api>.up.railway.app
API_BASEPATH=https://<api>.up.railway.app
NEXT_PUBLIC_PUBLIC_API_KEY=<same-as-api-PUBLIC_API_KEY>

NEXT_PUBLIC_SITE_URL=https://<public-viewer>.up.railway.app
```

## Supabase Auth URL 設定

Supabase Dashboard の Authentication URL 設定に Railway の URL を追加します。

Site URL:

```text
https://<public-viewer>.up.railway.app
```

Redirect URLs:

```text
https://<admin>.up.railway.app/login
https://<admin>.up.railway.app/reset-password
https://<public-viewer>.up.railway.app/login
https://<public-viewer>.up.railway.app/reset-password
```

## レポート成果物の保存

現状の API は `REPORT_DIR`、`CONFIG_DIR`、`INPUT_DIR`、`DATA_DIR/report_status.json` を使います。Railway の通常ファイルシステムは永続化前提ではないため、`api` サービスに Railway Volume を接続します。

Railway の `api` サービスで Volume を作成し、Mount Path を次のように設定します。

```text
/app/storage
```

そのうえで `api` サービスに次の環境変数を設定します。

```env
REPORT_DIR=/app/storage/outputs
CONFIG_DIR=/app/storage/configs
INPUT_DIR=/app/storage/inputs
DATA_DIR=/app/storage/data
```

新規組織作成時のサンプルレポートは、Volume にコピーされます。コピー元のサンプル成果物はイメージ内に同梱されているため、空の Volume でも初回作成できます。

小規模に始める場合は Railway Volume で十分です。API を水平スケールする場合は、Volume ではなく Azure Blob Storage などのオブジェクトストレージを正にしてください。

## デプロイ後確認

1. `api` の `/` が 200 を返すことを確認します。
2. `public-viewer` の `/login` が表示されることを確認します。
3. `admin` の `/login` が表示されることを確認します。
4. platform owner で `admin` にログインし、ユーザー発行画面を開きます。
5. 新規組織を作成し、サンプルレポートがその組織に表示されることを確認します。

## 注意点

- `NEXT_PUBLIC_*` はブラウザに露出します。秘密鍵は入れないでください。
- `ADMIN_API_KEY` / `PUBLIC_API_KEY` は既存 API の移行用キーです。認可判断は Supabase JWT と DB の membership で行います。
- `public-viewer` は認証付き SSR で動かします。静的 export では運用しません。
