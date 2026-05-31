# 認証・複数ユーザー利用の仕様とシステム設計

## 背景

現在の広聴AIは、管理画面 `apps/admin`、一般画面 `apps/public-viewer`、API `apps/api` が分離された構成です。管理画面には `BASIC_AUTH_USERNAME` / `BASIC_AUTH_PASSWORD` による Basic 認証がありますが、一般画面にはユーザー単位のログインはありません。API は `ADMIN_API_KEY` / `PUBLIC_API_KEY` を `x-api-key` ヘッダーで検証しています。

この方式は単一運用者が閉じた環境で利用するには簡単ですが、同じフロントエンド・バックエンドを複数ユーザーで共有する構成には不足があります。

- ユーザーごとのログインセッションがない
- レポートの作成者・閲覧者を区別できない
- レポートをユーザーまたは組織単位で認可できない
- 一般画面の閲覧権限をユーザー単位で制御できない
- API キーがサービス保護用であり、エンドユーザー認証にはならない

本ドキュメントでは、Supabase Auth を第一候補として、Railway 上で管理画面と一般画面の両方にユーザー認証を導入する設計を定義します。

## 目的

- 管理画面と一般画面の両方をログイン必須にできる
- 運用者がユーザーと初期パスワードを発行できる
- 同じ Railway 上のフロントエンド・バックエンドを複数ユーザーで共有できる
- ユーザー、組織、ロールに基づいてレポートの作成・編集・閲覧を制御できる
- 各ユーザーが投入した入力データと生成された成果物を1か月間だけ保持できる
- 既存の Basic 認証と API キー方式から段階的に移行できる

## 非目的

- SNS ログインや OAuth 連携を初期実装に含めない
- 課金、契約、利用量制限を初期実装に含めない
- レポート生成処理そのもののマルチワーカー化は本設計の範囲外とする
- 静的エクスポートされた `public-viewer` を認証付き公開することは対象外とする

## 推奨方針

認証基盤は Supabase Auth を採用する。理由は次の通りです。

- メールアドレスとパスワードによるユーザー管理が標準である
- セッションは JWT とリフレッシュトークンで管理される
- Next.js SSR 向けに Cookie ベースのセッション管理が用意されている
- FastAPI 側では `Authorization: Bearer <access_token>` を検証して API 認可に利用できる
- 将来的に Supabase Postgres を認可メタデータの保存先にできる

Railway では、次のサービスを同一プロジェクト内に配置する想定です。

| サービス | 役割 |
| --- | --- |
| `admin` | 管理画面 Next.js アプリ |
| `public-viewer` | 一般画面 Next.js アプリ |
| `api` | FastAPI バックエンド |
| Supabase | 外部マネージド認証・認可メタデータ |
| 永続ストレージ | レポート成果物の保存先。Railway Volume、Azure Blob Storage、Supabase Storage、Railway Buckets のいずれか |

## 対象ユーザーとロール

初期実装では「組織」をテナント境界として扱います。ユーザーは1つ以上の組織に所属できます。

| ロール | 管理画面 | 一般画面 | 主な権限 |
| --- | --- | --- | --- |
| `owner` | 可 | 可 | 組織設定、ユーザー管理、全レポート操作 |
| `admin` | 可 | 可 | レポート作成、編集、公開設定、閲覧 |
| `creator` | 可 | 可 | レポート作成、自分または所属組織のレポート編集 |
| `viewer` | 不可 | 可 | 許可されたレポートの閲覧 |

初期の運用では、ユーザー作成は Supabase Dashboard または運用者用スクリプトで行います。アプリ内の自己登録は無効にします。

## 認証フロー

### 管理画面

1. ユーザーが `admin` にアクセスする
2. Next.js middleware が Supabase セッション Cookie を確認する
3. 未ログインなら `/login` にリダイレクトする
4. ログイン後、middleware または server component がユーザーの組織ロールを確認する
5. `owner`、`admin`、`creator` 以外は管理画面を表示しない
6. API 呼び出し時は `Authorization: Bearer <access_token>` を付与する
7. API は JWT を検証し、管理操作に必要なロールを確認する

### 一般画面

1. ユーザーが `public-viewer` にアクセスする
2. Next.js middleware が Supabase セッション Cookie を確認する
3. 未ログインなら `/login` にリダイレクトする
4. `/reports` はログインユーザーが閲覧可能なレポートだけを返す
5. `/reports/{slug}` は対象レポートへの閲覧権限を API 側で検証する

### セッション共有

`admin` と `public-viewer` が同じドメイン配下にある場合は、Cookie ドメインを共通化してセッション共有を検討できます。

例:

- `admin.example.com`
- `app.example.com`
- Cookie domain: `.example.com`

ただし、初期実装では各アプリに同じログイン画面を置き、同じ Supabase プロジェクトで認証する方が安全です。Cookie 共有はデプロイ後のドメイン構成が確定してから判断します。

## システム構成

```text
Browser
  |
  | Cookie session
  v
Railway admin / public-viewer
  |
  | Authorization: Bearer <Supabase access token>
  v
Railway api
  |
  | Verify JWT with Supabase JWKS
  | Read authorization metadata
  v
Supabase Auth + Postgres
  |
  | Read/write report artifacts metadata
  v
Persistent report storage
```

フロントエンドはログイン状態の確認とログイン画面の提供を担当します。API は必ず JWT を再検証し、フロントエンドから渡されたユーザー情報を信用しません。

## データモデル

Supabase Postgres に認可メタデータを保存します。レポート本体の JSON や CSV などの成果物は、既存の `REPORT_DIR` 方式を残すか、オブジェクトストレージに移します。

### `profiles`

Supabase Auth の `auth.users` を補完するユーザープロフィールです。

| カラム | 型 | 説明 |
| --- | --- | --- |
| `user_id` | uuid | `auth.users.id` |
| `display_name` | text | 表示名 |
| `created_at` | timestamptz | 作成日時 |
| `updated_at` | timestamptz | 更新日時 |

### `organizations`

| カラム | 型 | 説明 |
| --- | --- | --- |
| `id` | uuid | 組織ID |
| `name` | text | 組織名 |
| `slug` | text | URLや管理用の識別子 |
| `created_at` | timestamptz | 作成日時 |

### `organization_memberships`

| カラム | 型 | 説明 |
| --- | --- | --- |
| `organization_id` | uuid | 組織ID |
| `user_id` | uuid | ユーザーID |
| `role` | text | `owner` / `admin` / `creator` / `viewer` |
| `created_at` | timestamptz | 作成日時 |

`organization_id` と `user_id` の組み合わせを一意にします。

### `reports`

| カラム | 型 | 説明 |
| --- | --- | --- |
| `id` | uuid | レポートID |
| `slug` | text | 既存APIで使っているレポートslug |
| `organization_id` | uuid | 所属組織 |
| `created_by` | uuid | 作成者 |
| `title` | text | レポート名 |
| `status` | text | `processing` / `ready` / `error` / `deleted` |
| `visibility` | text | `private` / `unlisted` / `public` |
| `artifact_path` | text | 成果物の保存パス |
| `retention_expires_at` | timestamptz | 入力データ・生成成果物の保持期限 |
| `purged_at` | timestamptz | 成果物を物理削除した日時 |
| `purge_status` | text | `active` / `pending` / `purged` / `failed` |
| `created_at` | timestamptz | 作成日時 |
| `updated_at` | timestamptz | 更新日時 |

`visibility` の意味はログイン必須化後も維持します。

| visibility | 意味 |
| --- | --- |
| `private` | 同じ組織の許可されたユーザーのみ閲覧可 |
| `unlisted` | 同じ組織のユーザーがURLを知っていれば閲覧可 |
| `public` | 初期実装では「ログイン済みユーザーに公開」。完全公開は別機能として扱う |

### `report_permissions`（任意）

組織単位ではなくユーザー単位でレポートを共有したい場合に追加します。

| カラム | 型 | 説明 |
| --- | --- | --- |
| `report_id` | uuid | レポートID |
| `user_id` | uuid | ユーザーID |
| `permission` | text | `view` / `edit` |

初期実装では組織単位の権限だけでもよいです。

## データ保持ポリシー

各ユーザーが広聴AIに投入したデータと、そこから生成されたデータは1か月間保持します。実装上は暦月の差異を避けるため、初期値を `RETENTION_DAYS=30` とし、必要に応じて環境変数で変更できるようにします。

### 保持対象

保持期限の対象は、ユーザー入力または分析実行により生成されるデータです。

- アップロードされた CSV
- スプレッドシート等から取り込んだ入力データ
- レポート生成用 config
- 解析途中の中間ファイル
- 生成済みレポート JSON
- ダウンロード用 CSV
- 可視化設定
- 画像、メタデータ、その他レポート成果物

次のデータは1か月削除の対象外とします。

- Supabase Auth のユーザーアカウント
- `profiles`
- `organizations`
- `organization_memberships`
- 認可判定に必要な最小限のレポートメタデータ
- 監査ログ

ただし、対象外データにも個人情報が含まれる場合は、別途プライバシーポリシーと運用ルールで保持期間を定めます。

### 保持期限の起点

保持期限は、原則としてレポート作成リクエストを受け付けた時刻を起点にします。

```text
retention_expires_at = report.created_at + RETENTION_DAYS
```

生成処理が長時間かかった場合でも、入力データの投入時点から1か月後に削除対象になります。レポートを複製した場合は、複製先レポートの `created_at` を起点に新しい保持期限を設定します。

### 期限切れ後の挙動

`retention_expires_at` を過ぎたレポートは、まず API で閲覧・編集・ダウンロード不可にします。その後、定期削除ジョブで成果物を物理削除します。

| 状態 | 挙動 |
| --- | --- |
| 期限内 | 通常通り閲覧・編集・ダウンロード可 |
| 期限切れ・削除前 | API は 410 Gone または 404 を返す。管理画面には期限切れとして表示可能 |
| 削除済み | 成果物はストレージから削除。最小限のメタデータだけ残す |

ユーザーまたは管理者による手動削除は、1か月を待たずに実行できます。

### 削除ジョブ

Railway では、日次の Cron Job サービスとして削除処理を実行します。Railway Cron Job はスケジュールに従ってサービスの start command を実行し、処理完了後に終了する前提のため、定期削除処理に適しています。

削除ジョブは冪等にします。

1. `retention_expires_at <= now()` かつ `purge_status != 'purged'` のレポートを取得する
2. `purge_status = 'pending'` に更新する
3. `artifact_path` 配下の入力・中間・生成ファイルを削除する
4. Supabase Storage、Railway Buckets、Azure Blob Storage 等を使う場合は対応するオブジェクトも削除する
5. 成功時は `purge_status = 'purged'`、`purged_at = now()` に更新する
6. 失敗時は `purge_status = 'failed'` とエラー概要を監査ログに残す

削除対象ファイルのパスは必ず `artifact_path` またはストレージキーから導出し、ユーザー入力文字列を直接ファイルパスとして扱いません。

### UI 表示

管理画面と一般画面には、レポートの保持期限を表示します。

- レポート一覧に「保持期限」を表示する
- 期限切れ7日前から警告を表示する
- 期限切れ後は閲覧不可であることを明示する
- 手動削除が可能なロールには削除導線を表示する

## API 認証・認可

API には共通の依存関数を追加します。

- `get_current_user()`
  - `Authorization` ヘッダーから Bearer token を取得
  - Supabase JWT を検証
  - `sub` をユーザーIDとして取得
- `require_member(organization_id)`
  - ユーザーが対象組織に所属していることを確認
- `require_role(organization_id, roles)`
  - ユーザーが必要ロールを持つことを確認
- `require_report_access(slug, permission)`
  - レポートの組織、visibility、個別権限を確認

既存の `verify_admin_api_key` / `verify_public_api_key` は段階移行のため残します。ただしユーザー認証導入後は、API キーだけで管理操作やレポート閲覧を許可してはいけません。

移行期の条件は次のようにします。

```text
AUTH_ENABLED=false:
  既存通り x-api-key のみで認証

AUTH_ENABLED=true:
  x-api-key はサービス間の補助的な共有シークレット
  ユーザー操作は Authorization: Bearer <JWT> を必須にする
```

## JWT 検証

Supabase Auth はログイン済みユーザーに JWT access token を発行します。API では以下のどちらかで検証します。

1. Supabase の JWKS を取得してローカル検証する
2. Supabase Auth API に問い合わせてトークンを検証する

本番では JWKS によるローカル検証を推奨します。リクエストごとに外部APIへ問い合わせるより安定し、APIのホットパスから認証サーバーへの依存を減らせるためです。

Supabase プロジェクトは、可能であれば非対称署名キーを利用します。レガシーJWTシークレットによる共有鍵検証を使う場合、鍵漏えい時の影響が大きく、ローテーションも難しくなります。

## フロントエンド設計

両フロントエンドに共通の認証ユーティリティを追加します。

```text
apps/admin/
  app/login/page.tsx
  middleware.ts
  app/utils/supabase/

apps/public-viewer/
  app/login/page.tsx
  middleware.ts
  app/utils/supabase/
```

重複が増える場合は、後続で `packages/auth` のような共有パッケージに切り出します。

### ログイン画面

初期実装はメールアドレスとパスワードのみです。

- メールアドレス
- パスワード
- ログインボタン
- ログアウトボタン
- パスワードリセット導線

自己登録画面は提供しません。ユーザー発行は運用者が行います。

### middleware

`apps/admin/middleware.ts` は Basic 認証から Supabase セッション確認に置き換えます。

`apps/public-viewer` には新しく middleware を追加し、以下を保護します。

- `/`
- `/[slug]`
- `/faq` は公開してよいか要件次第で決める
- `/_next/*`、画像、静的ファイル、`/login` は除外する

### API 呼び出し

フロントエンドから API を呼ぶ際は、Supabase session から access token を取得して付与します。

```text
Authorization: Bearer <access_token>
x-api-key: <existing service api key during migration>
```

`NEXT_PUBLIC_PUBLIC_API_KEY` と `NEXT_PUBLIC_ADMIN_API_KEY` はブラウザに露出するため、ユーザー認証の代替として扱ってはいけません。

## Railway 配置

Railway ではサービスごとに環境変数を設定します。Railway の Variables はサービス単位で管理し、`.env` から候補を検出できます。

### 共通

```env
AUTH_ENABLED=true
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<supabase-anon-key>
NEXT_PUBLIC_API_BASEPATH=https://<api-service>.up.railway.app
```

### `api`

```env
AUTH_ENABLED=true
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_JWKS_URL=https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
SUPABASE_JWT_ISSUER=https://<project-ref>.supabase.co/auth/v1
SUPABASE_SERVICE_ROLE_KEY=<server-only-service-role-key>
ADMIN_API_KEY=<internal-admin-api-key>
PUBLIC_API_KEY=<internal-public-api-key>
RETENTION_DAYS=30
```

`SUPABASE_SERVICE_ROLE_KEY` は API サービスだけに設定します。フロントエンドサービスには絶対に設定しません。

### `retention-purge` Cron Job

Railway に削除専用サービスを追加します。API と同じ Docker image または同じリポジトリから起動し、start command は削除コマンドだけを実行して終了します。

```env
AUTH_ENABLED=true
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-only-service-role-key>
REPORT_STORAGE_TYPE=<azure_blob|supabase_storage|railway_bucket|railway_volume>
RETENTION_DAYS=30
```

Cron schedule は1日1回を基本にします。削除遅延を小さくしたい場合でも、まずは日次で十分です。

### レポート成果物の保存

Railway で `REPORT_DIR` にファイルを書き続ける場合は、API サービスに Railway Volume を接続します。Volume はサービスの実行時にマウントされるため、ビルド時の書き込み先には使えません。

推奨は次の順です。

1. 既存の Azure Blob Storage を使う
2. Supabase Storage または Railway Buckets へ移行する
3. 小規模運用に限り Railway Volume を使う

Railway Volume は単一サービスにマウントする永続ファイルシステムとして扱い、複数APIインスタンスで同じファイルを同時共有する前提にはしません。将来的に API を水平スケールする場合は、オブジェクトストレージを正とします。

## 実装ステップ

### Phase 1: 認証基盤の導入

- Supabase プロジェクトを作成する
- メール/パスワード認証を有効にする
- 自己登録を無効にする
- `profiles`、`organizations`、`organization_memberships`、`reports` テーブルを追加する
- Railway に Supabase 関連の環境変数を設定する

### Phase 2: フロントエンド保護

- `admin` に Supabase SSR クライアントを追加する
- `admin` の Basic 認証 middleware を置き換える
- `public-viewer` に middleware とログイン画面を追加する
- ログアウト導線を両画面に追加する

### Phase 3: API 認証・認可

- FastAPI に JWT 検証依存関数を追加する
- `/admin/*` は `owner` / `admin` / `creator` に制限する
- `/reports` はログインユーザーが閲覧可能なレポートだけ返す
- `/reports/{slug}` は対象レポートへの閲覧権限を検証する
- 既存の `x-api-key` は移行期の補助に格下げする

### Phase 4: レポート所有権の移行

- 既存レポートに `organization_id` と `created_by` を付与する
- 既存レポートに `retention_expires_at`、`purge_status` を付与する
- status JSON と Supabase `reports` テーブルの同期方法を決める
- 新規レポート作成時に作成者と組織を保存する
- 新規レポート作成時に保持期限を保存する
- 削除、複製、可視化設定更新、クラスタ編集に認可チェックを追加する

### Phase 5: Railway 本番運用

- `admin`、`public-viewer`、`api` を Railway に配置する
- `retention-purge` Cron Job を Railway に配置する
- API サービスの永続ストレージを決める
- HTTPS ドメインを確定する
- Supabase Auth のリダイレクトURLに Railway の本番URLを登録する
- ログ、監査、バックアップ方針を設定する

## 既存機能への影響

### Basic 認証

`AUTH_ENABLED=true` では Basic 認証を使いません。後方互換のため、`AUTH_ENABLED=false` の環境では既存の Basic 認証を残してもよいです。

### 静的ホスティング

認証付き一般画面は SSR と Cookie セッションが必要です。そのため `public-viewer` の `build:static` による静的配信は、認証必須モードとは両立しません。認証必須にする場合は Next.js サーバーとして Railway に配置します。

### public / unlisted レポート

初期実装では、一般画面全体をログイン必須にします。そのため `public` は「ログイン済みユーザーに公開」という意味になります。ログインなしの完全公開URLを残す場合は、別途 `ALLOW_ANONYMOUS_PUBLIC_REPORTS=true` のような機能フラグで明示的に分けます。

## セキュリティ要件

- パスワードは広聴AI側で保存しない
- `SUPABASE_SERVICE_ROLE_KEY` をフロントエンドに渡さない
- API はフロントエンドの認可結果を信用せず、毎回 JWT と権限を検証する
- 管理系 API は `viewer` から呼べない
- レポート成果物の保存パスは認可後に解決する
- slug だけで他組織のレポートを推測・閲覧できない
- 監査ログにユーザーID、操作、対象レポート、時刻を残す
- ログに access token、refresh token、service role key、ユーザーAPIキーを出力しない
- 期限切れレポートは、削除ジョブ実行前でも API から閲覧・編集・ダウンロードできない
- 削除ジョブは `artifact_path` 外のファイルを削除できない

## テスト方針

- 未ログインで `admin` にアクセスすると `/login` に遷移する
- 未ログインで `public-viewer` にアクセスすると `/login` に遷移する
- `viewer` は管理画面にアクセスできない
- `creator` はレポートを作成できる
- 別組織のユーザーはレポート一覧にも詳細にもアクセスできない
- `private` レポートは許可ユーザー以外に返らない
- JWT なし、期限切れJWT、不正署名JWTは 401 になる
- 権限不足は 403 になる
- `retention_expires_at` を過ぎたレポートは一般画面の一覧・詳細・ダウンロードで取得できない
- 削除ジョブは期限切れレポートの入力ファイルと生成成果物を削除する
- 削除ジョブを複数回実行しても結果が壊れない
- 削除に失敗した場合は `purge_status = 'failed'` になり、次回再試行できる
- `AUTH_ENABLED=false` では既存のローカル開発フローが壊れない

## 未決定事項

- 組織をユーザー作成時に必須にするか、後から割り当てるか
- ユーザー招待メールを Supabase から送るか、運用者が初期パスワードを個別連絡するか
- `public` レポートをログイン不要で残すか
- レポート成果物の最終保存先を Azure Blob Storage、Supabase Storage、Railway Buckets、Railway Volume のどれにするか
- `admin` と `public-viewer` のセッションCookieを本番ドメインで共有するか
- 期限切れレポートを管理画面に何日間表示してからメタデータも削除するか

## 参考

- Supabase Auth: <https://supabase.com/docs/guides/auth/>
- Supabase Auth with Next.js: <https://supabase.com/docs/guides/auth/quickstarts/nextjs>
- Supabase Server-Side Auth: <https://supabase.com/docs/guides/auth/server-side>
- Supabase JWT: <https://supabase.com/docs/guides/auth/jwts>
- Railway Variables: <https://docs.railway.com/variables>
- Railway Volumes: <https://docs.railway.com/volumes>
- Railway Cron Jobs: <https://docs.railway.com/reference/cron-jobs>
