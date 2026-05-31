"use client";

import { getApiBaseUrl } from "@/app/utils/api";
import { createClient } from "@/app/utils/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Alert,
  Badge,
  Box,
  Field,
  HStack,
  Heading,
  Input,
  NativeSelect,
  Tabs,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import Papa from "papaparse";
import { type FormEvent, useCallback, useEffect, useState } from "react";

type Role = "owner" | "admin" | "creator" | "viewer";

type CreatedUser = {
  user_id: string;
  email: string;
  organization_slug: string;
  role: Role;
};

type IssuedUser = CreatedUser & {
  password: string;
  display_name: string;
  organization_name: string;
  login_url: string;
};

type BatchUserInput = {
  email: string;
  password: string;
  display_name: string;
  organization_slug: string;
  organization_name: string | null;
  role: Role;
};

type BatchCreateUserResult = {
  row: number;
  success: boolean;
  user: CreatedUser | null;
  error: string | null;
};

type ManagedUser = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  organization_slug: string;
  organization_name: string;
  role: Role;
  can_delete: boolean;
};

type ManageableOrganization = {
  id: string;
  slug: string;
  name: string;
  role: "platform_owner" | "owner" | "admin";
  assignable_roles: Role[];
};

type OrganizationMetadata = {
  organization_slug: string;
  reporter: string | null;
  message: string | null;
  web_link: string | null;
  privacy_link: string | null;
  terms_link: string | null;
  brand_color: string | null;
  has_icon_png: boolean;
  has_ogp_png: boolean;
  has_reporter_png: boolean;
};

const roleDescriptions: Record<Role, string> = {
  owner: "組織の責任者。組織内の admin / creator / viewer を管理できます。",
  admin: "広聴AI オンラインの運用担当者。組織内の creator / viewer を招待できます。",
  creator: "レポートを作成・編集する担当者です。",
  viewer: "共有されたレポートを閲覧する利用者です。",
};

const csvHeaders = ["email", "password", "display_name", "organization_slug", "organization_name", "role"];

const generateTemporaryPassword = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!_-";
  const values = new Uint32Array(14);
  window.crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
};

const normalizeCsvValue = (value: unknown) => String(value ?? "").trim();

const isRole = (value: string): value is Role => ["owner", "admin", "creator", "viewer"].includes(value);

export function UserIssueForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [organizationSlug, setOrganizationSlug] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [isPlatformOwner, setIsPlatformOwner] = useState(false);
  const [manageableOrganizations, setManageableOrganizations] = useState<ManageableOrganization[]>([]);
  const [isContextLoaded, setIsContextLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [isUsersLoading, setIsUsersLoading] = useState(false);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [createdUser, setCreatedUser] = useState<IssuedUser | null>(null);
  const [batchUsers, setBatchUsers] = useState<BatchUserInput[]>([]);
  const [batchResults, setBatchResults] = useState<BatchCreateUserResult[]>([]);
  const [batchFileName, setBatchFileName] = useState("");
  const [isBatchLoading, setIsBatchLoading] = useState(false);
  const [isBatchCopying, setIsBatchCopying] = useState(false);
  const [managedUsers, setManagedUsers] = useState<ManagedUser[]>([]);
  const [managedUsersOrganizationSlug, setManagedUsersOrganizationSlug] = useState("");
  const [organizationMetadata, setOrganizationMetadata] = useState<OrganizationMetadata | null>(null);
  const [metadataReporter, setMetadataReporter] = useState("");
  const [metadataMessage, setMetadataMessage] = useState("");
  const [metadataWebLink, setMetadataWebLink] = useState("");
  const [metadataPrivacyLink, setMetadataPrivacyLink] = useState("");
  const [metadataTermsLink, setMetadataTermsLink] = useState("");
  const [metadataBrandColor, setMetadataBrandColor] = useState("#2577b1");
  const [metadataIconFile, setMetadataIconFile] = useState<File | null>(null);
  const [metadataOgpFile, setMetadataOgpFile] = useState<File | null>(null);
  const [metadataReporterFile, setMetadataReporterFile] = useState<File | null>(null);
  const [isMetadataLoading, setIsMetadataLoading] = useState(false);
  const [isMetadataSaving, setIsMetadataSaving] = useState(false);

  const selectedOrganization = manageableOrganizations.find((organization) => organization.slug === organizationSlug);
  const hasInvitePermission = isPlatformOwner || manageableOrganizations.length > 0;
  const assignableRoles =
    selectedOrganization?.assignable_roles ??
    (isPlatformOwner ? (["viewer", "creator", "admin", "owner"] satisfies Role[]) : []);

  const issuedUserText = createdUser
    ? [
        "ユーザーを発行しました。",
        `ログインURL: ${createdUser.login_url}`,
        `メールアドレス: ${createdUser.email}`,
        `初期パスワード: ${createdUser.password}`,
        `表示名: ${createdUser.display_name}`,
        `組織 slug: ${createdUser.organization_slug}`,
        `組織名: ${createdUser.organization_name}`,
        `ロール: ${createdUser.role}`,
      ].join("\n")
    : "";
  const batchIssuedUserText =
    batchResults.length > 0
      ? batchResults
          .flatMap((result) => {
            if (!result.success || !result.user) {
              return [];
            }

            const source = batchUsers[result.row - 1];
            const loginUrl = typeof window === "undefined" ? "/login" : `${window.location.origin}/login`;
            return [
              [
                "ユーザーを発行しました。",
                `ログインURL: ${loginUrl}`,
                `メールアドレス: ${result.user.email}`,
                `初期パスワード: ${source?.password ?? ""}`,
                `表示名: ${source?.display_name ?? ""}`,
                `組織 slug: ${result.user.organization_slug}`,
                `組織名: ${source?.organization_name || result.user.organization_slug}`,
                `ロール: ${result.user.role}`,
              ].join("\n"),
            ];
          })
          .join("\n\n")
      : "";
  const batchSuccessCount = batchResults.filter((result) => result.success).length;
  const batchFailureCount = batchResults.filter((result) => !result.success).length;
  const messageColor =
    message && (message.includes("しました") || message.includes("コピー")) ? "green.700" : "red.600";

  const getAuthHeaders = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    return {
      "x-api-key": process.env.NEXT_PUBLIC_ADMIN_API_KEY || "",
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    };
  }, []);

  const loadManagedUsers = useCallback(async () => {
    setIsUsersLoading(true);
    try {
      const searchParams = new URLSearchParams();
      if (managedUsersOrganizationSlug) {
        searchParams.set("organization_slug", managedUsersOrganizationSlug);
      }
      const queryString = searchParams.toString();
      const response = await fetch(`${getApiBaseUrl()}/admin/users${queryString ? `?${queryString}` : ""}`, {
        headers: await getAuthHeaders(),
      });
      if (!response.ok) {
        return;
      }
      const data: { users: ManagedUser[] } = await response.json();
      setManagedUsers(data.users);
    } finally {
      setIsUsersLoading(false);
    }
  }, [getAuthHeaders, managedUsersOrganizationSlug]);

  const applyOrganizationMetadata = useCallback((metadata: OrganizationMetadata | null) => {
    setOrganizationMetadata(metadata);
    setMetadataReporter(metadata?.reporter ?? "");
    setMetadataMessage(metadata?.message ?? "");
    setMetadataWebLink(metadata?.web_link ?? "");
    setMetadataPrivacyLink(metadata?.privacy_link ?? "");
    setMetadataTermsLink(metadata?.terms_link ?? "");
    setMetadataBrandColor(metadata?.brand_color ?? "#2577b1");
    setMetadataIconFile(null);
    setMetadataOgpFile(null);
    setMetadataReporterFile(null);
  }, []);

  const loadOrganizationMetadata = useCallback(
    async (slug: string) => {
      if (!slug) {
        applyOrganizationMetadata(null);
        return;
      }

      setIsMetadataLoading(true);
      try {
        const response = await fetch(`${getApiBaseUrl()}/admin/organizations/${encodeURIComponent(slug)}/metadata`, {
          headers: await getAuthHeaders(),
        });
        if (!response.ok) {
          applyOrganizationMetadata(null);
          return;
        }

        applyOrganizationMetadata(await response.json());
      } finally {
        setIsMetadataLoading(false);
      }
    },
    [applyOrganizationMetadata, getAuthHeaders],
  );

  useEffect(() => {
    let isMounted = true;

    async function loadUserManagementContext() {
      try {
        const response = await fetch(`${getApiBaseUrl()}/admin/user-management/context`, {
          headers: await getAuthHeaders(),
        });

        if (!response.ok) {
          setIsContextLoaded(true);
          return;
        }

        const context: { platform_owner: boolean; organizations: ManageableOrganization[] } = await response.json();
        if (!isMounted) {
          return;
        }

        setIsPlatformOwner(context.platform_owner);
        setManageableOrganizations(context.organizations);
        if (!context.platform_owner && context.organizations.length > 0) {
          const firstOrganization = context.organizations[0];
          setOrganizationSlug((current) => current || firstOrganization.slug);
          setOrganizationName((current) => current || firstOrganization.name);
          setRole(firstOrganization.assignable_roles[0] ?? "viewer");
        }
      } catch {
        return;
      } finally {
        if (isMounted) {
          setIsContextLoaded(true);
        }
      }
    }

    loadUserManagementContext();

    return () => {
      isMounted = false;
    };
  }, [getAuthHeaders]);

  useEffect(() => {
    if (isContextLoaded && hasInvitePermission) {
      loadManagedUsers();
    }
  }, [hasInvitePermission, isContextLoaded, loadManagedUsers]);

  useEffect(() => {
    if (selectedOrganization && !selectedOrganization.assignable_roles.includes(role)) {
      setRole(selectedOrganization.assignable_roles[0] ?? "viewer");
    }
  }, [role, selectedOrganization]);

  useEffect(() => {
    if (selectedOrganization) {
      loadOrganizationMetadata(selectedOrganization.slug);
    } else {
      applyOrganizationMetadata(null);
    }
  }, [applyOrganizationMetadata, loadOrganizationMetadata, selectedOrganization]);

  async function fileToData(file: File | null) {
    if (!file) {
      return undefined;
    }

    return new Promise<{ data: string }>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ data: String(reader.result) });
      reader.onerror = () => reject(new Error("画像を読み込めませんでした。"));
      reader.readAsDataURL(file);
    });
  }

  async function handleSubmit(event: FormEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsLoading(true);
    setMessage(null);
    setCreatedUser(null);

    try {
      const response = await fetch(`${getApiBaseUrl()}/admin/users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await getAuthHeaders()),
        },
        body: JSON.stringify({
          email,
          password,
          display_name: displayName,
          organization_slug: organizationSlug,
          organization_name: selectedOrganization?.name || organizationName || null,
          role,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.detail || `ユーザーを発行できませんでした。HTTP ${response.status}`);
      }

      const user: CreatedUser = await response.json();
      setCreatedUser({
        ...user,
        password,
        display_name: displayName,
        organization_name: selectedOrganization?.name || organizationName || organizationSlug,
        login_url: `${window.location.origin}/login`,
      });
      setMessage("ユーザーを発行しました。");
      setEmail("");
      setPassword("");
      setDisplayName("");
      await loadManagedUsers();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ユーザーを発行できませんでした。");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDeleteUser(user: ManagedUser) {
    if (!window.confirm(`${user.email || user.user_id} を ${user.organization_slug} から削除しますか？`)) {
      return;
    }

    setDeletingUserId(user.user_id);
    setMessage(null);
    try {
      const response = await fetch(
        `${getApiBaseUrl()}/admin/users/${user.user_id}?organization_slug=${encodeURIComponent(user.organization_slug)}`,
        {
          method: "DELETE",
          headers: await getAuthHeaders(),
        },
      );
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.detail || `ユーザーを削除できませんでした。HTTP ${response.status}`);
      }

      setCreatedUser(null);
      setMessage("ユーザーを削除しました。");
      await loadManagedUsers();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ユーザーを削除できませんでした。");
    } finally {
      setDeletingUserId(null);
    }
  }

  function handleIssueAnotherUser() {
    setCreatedUser(null);
    setMessage(null);
  }

  async function handleCopyIssuedUser() {
    if (!issuedUserText) {
      return;
    }

    setIsCopying(true);
    try {
      await navigator.clipboard.writeText(issuedUserText);
      setMessage("ユーザー発行情報をコピーしました。");
    } catch {
      setMessage("コピーできませんでした。下の内容を選択してコピーしてください。");
    } finally {
      setIsCopying(false);
    }
  }

  async function handleBatchCsvFile(file: File | null) {
    setBatchResults([]);
    setBatchUsers([]);
    setBatchFileName(file?.name ?? "");
    setMessage(null);

    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const parsed = Papa.parse<Record<string, string>>(text, {
        header: true,
        skipEmptyLines: "greedy",
      });
      if (parsed.errors.length > 0) {
        throw new Error(parsed.errors[0].message);
      }

      const users = parsed.data
        .map((row) => {
          const emailValue = normalizeCsvValue(row.email).toLowerCase();
          const roleValue = normalizeCsvValue(row.role) || role;
          const displayNameValue = normalizeCsvValue(row.display_name) || emailValue.split("@")[0] || "user";
          const organizationSlugValue = normalizeCsvValue(row.organization_slug || organizationSlug).toLowerCase();
          const organizationNameValue = normalizeCsvValue(
            row.organization_name || organizationName || selectedOrganization?.name,
          );

          if (!emailValue) {
            return null;
          }
          if (!isRole(roleValue)) {
            throw new Error(`CSVの role は owner / admin / creator / viewer のいずれかにしてください: ${roleValue}`);
          }

          return {
            email: emailValue,
            password: normalizeCsvValue(row.password) || generateTemporaryPassword(),
            display_name: displayNameValue,
            organization_slug: organizationSlugValue,
            organization_name: organizationNameValue || null,
            role: roleValue,
          };
        })
        .filter((user): user is BatchUserInput => user !== null);

      if (users.length === 0) {
        throw new Error("CSVに発行対象のユーザーがありません。");
      }
      if (users.length > 100) {
        throw new Error("CSVで一度に発行できるユーザーは100件までです。");
      }

      setBatchUsers(users);
      setMessage(`${users.length}件のユーザーを読み込みました。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "CSVを読み込めませんでした。");
    }
  }

  async function handleBatchSubmit() {
    if (batchUsers.length === 0) {
      setMessage("CSVを選択してください。");
      return;
    }

    setIsBatchLoading(true);
    setBatchResults([]);
    setCreatedUser(null);
    setMessage(null);
    try {
      const response = await fetch(`${getApiBaseUrl()}/admin/users/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await getAuthHeaders()),
        },
        body: JSON.stringify({ users: batchUsers }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.detail || `ユーザーを一括発行できませんでした。HTTP ${response.status}`);
      }

      const data: { results: BatchCreateUserResult[] } = await response.json();
      setBatchResults(data.results);
      const successCount = data.results.filter((result) => result.success).length;
      const failureCount = data.results.length - successCount;
      setMessage(`一括発行が完了しました。成功 ${successCount}件 / 失敗 ${failureCount}件`);
      await loadManagedUsers();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ユーザーを一括発行できませんでした。");
    } finally {
      setIsBatchLoading(false);
    }
  }

  async function handleCopyBatchIssuedUsers() {
    if (!batchIssuedUserText) {
      return;
    }

    setIsBatchCopying(true);
    try {
      await navigator.clipboard.writeText(batchIssuedUserText);
      setMessage("一括発行情報をコピーしました。");
    } catch {
      setMessage("コピーできませんでした。下の内容を選択してコピーしてください。");
    } finally {
      setIsBatchCopying(false);
    }
  }

  function handleDownloadCsvTemplate() {
    const example = [
      csvHeaders.join(","),
      [
        "sample_viewer@example.com",
        "",
        "sample_viewer",
        organizationSlug || "test-org",
        organizationName || "test-organization",
        "viewer",
      ].join(","),
    ].join("\n");
    const blob = new Blob([example], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "kouchou-ai-users-template.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleSaveOrganizationMetadata() {
    if (!selectedOrganization) {
      setMessage("既存の組織を選択してください。新規組織は作成後に設定できます。");
      return;
    }

    setIsMetadataSaving(true);
    setMessage(null);
    try {
      const response = await fetch(
        `${getApiBaseUrl()}/admin/organizations/${encodeURIComponent(selectedOrganization.slug)}/metadata`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...(await getAuthHeaders()),
          },
          body: JSON.stringify({
            reporter: metadataReporter || null,
            message: metadataMessage || null,
            web_link: metadataWebLink || null,
            privacy_link: metadataPrivacyLink || null,
            terms_link: metadataTermsLink || null,
            brand_color: metadataBrandColor || null,
            icon_png: await fileToData(metadataIconFile),
            ogp_png: await fileToData(metadataOgpFile),
            reporter_png: await fileToData(metadataReporterFile),
          }),
        },
      );
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.detail || `組織表示設定を保存できませんでした。HTTP ${response.status}`);
      }

      applyOrganizationMetadata(await response.json());
      setMessage("組織表示設定を保存しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "組織表示設定を保存できませんでした。");
    } finally {
      setIsMetadataSaving(false);
    }
  }

  return (
    <Box bg="white" borderWidth="1px" borderColor="border.weak" borderRadius="8px" p="8">
      <VStack gap="5" align="stretch">
        <Box>
          <HStack gap="3" align="center" mb="2">
            <Heading fontSize="xl">広聴AI オンライン ユーザー招待</Heading>
            <Badge colorPalette={isPlatformOwner ? "purple" : hasInvitePermission ? "blue" : "gray"}>
              {isPlatformOwner ? "platform owner" : hasInvitePermission ? "organization manager" : "invite unavailable"}
            </Badge>
          </HStack>
          <Text color="gray.600" fontSize="sm">
            広聴AI
            オンラインに参加する組織と利用者を発行します。発行後に表示されるログイン情報を招待相手へ共有してください。
          </Text>
        </Box>
        <Alert.Root status={isPlatformOwner ? "info" : hasInvitePermission ? "warning" : "error"}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title fontSize="sm">
              {isPlatformOwner
                ? "プラットフォームオーナー権限で操作中"
                : hasInvitePermission
                  ? "自組織の招待権限で操作中"
                  : "ユーザー発行権限がありません"}
            </Alert.Title>
            <Alert.Description fontSize="sm">
              {isPlatformOwner
                ? "新しい組織を作成し、初期 owner / admin / creator / viewer を発行できます。通常運用では、組織の owner または admin に利用者招待を委任してください。"
                : hasInvitePermission
                  ? "選択できる組織とロールは、あなたが管理できる範囲に制限されています。他組織への招待や owner の発行はできません。"
                  : "creator / viewer はユーザーを発行できません。招待が必要な場合は、組織の admin または owner に依頼してください。"}
            </Alert.Description>
          </Alert.Content>
        </Alert.Root>
        {!isContextLoaded && <Text color="gray.600">招待権限を確認しています。</Text>}
        {isContextLoaded && !hasInvitePermission && (
          <Box borderWidth="1px" borderColor="border.weak" borderRadius="8px" p="4">
            <Text color="gray.700" fontSize="sm">
              このアカウントでは広聴AI オンラインのユーザー招待はできません。
            </Text>
          </Box>
        )}
        {isContextLoaded && hasInvitePermission && (
          <>
            {message && <Text color={messageColor}>{message}</Text>}
            <Tabs.Root defaultValue="single" variant="line">
              <Tabs.List overflowX="auto">
                <Tabs.Trigger value="single">ユーザー発行</Tabs.Trigger>
                <Tabs.Trigger value="batch">CSV一括発行</Tabs.Trigger>
                <Tabs.Trigger value="metadata">組織表示設定</Tabs.Trigger>
                <Tabs.Trigger value="users">発行済みユーザー</Tabs.Trigger>
                <Tabs.Indicator />
              </Tabs.List>
              <Tabs.Content value="single" pt="5">
                <Box as="form" onSubmit={handleSubmit}>
                  <VStack align="stretch" gap="4">
                    <Field.Root required>
                      <Field.Label>メールアドレス</Field.Label>
                      <Input
                        type="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        autoComplete="off"
                      />
                    </Field.Root>
                    <Field.Root required>
                      <Field.Label>初期パスワード</Field.Label>
                      <Input
                        type="password"
                        minLength={8}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete="new-password"
                      />
                    </Field.Root>
                    <Field.Root required>
                      <Field.Label>表示名</Field.Label>
                      <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
                    </Field.Root>
                    <Field.Root required>
                      <Field.Label>組織 slug</Field.Label>
                      {manageableOrganizations.length > 0 && !isPlatformOwner ? (
                        <NativeSelect.Root>
                          <NativeSelect.Field
                            value={organizationSlug}
                            onChange={(event) => {
                              const nextOrganization = manageableOrganizations.find(
                                (organization) => organization.slug === event.target.value,
                              );
                              setOrganizationSlug(event.target.value);
                              setOrganizationName(nextOrganization?.name ?? "");
                              setRole(nextOrganization?.assignable_roles[0] ?? "viewer");
                            }}
                          >
                            {manageableOrganizations.map((organization) => (
                              <option key={organization.id} value={organization.slug}>
                                {organization.slug}
                              </option>
                            ))}
                          </NativeSelect.Field>
                          <NativeSelect.Indicator />
                        </NativeSelect.Root>
                      ) : (
                        <>
                          <Input
                            value={organizationSlug}
                            onChange={(event) => {
                              const nextSlug = event.target.value.toLowerCase();
                              const nextOrganization = manageableOrganizations.find(
                                (organization) => organization.slug === nextSlug,
                              );
                              setOrganizationSlug(nextSlug);
                              if (nextOrganization) {
                                setOrganizationName(nextOrganization.name);
                                setRole(nextOrganization.assignable_roles[0] ?? "viewer");
                              }
                            }}
                            pattern="[a-z0-9](([a-z0-9]|-)*[a-z0-9])?"
                            list={isPlatformOwner ? "manageable-organizations" : undefined}
                          />
                          {isPlatformOwner && (
                            <datalist id="manageable-organizations">
                              {manageableOrganizations.map((organization) => (
                                <option key={organization.id} value={organization.slug}>
                                  {organization.name}
                                </option>
                              ))}
                            </datalist>
                          )}
                        </>
                      )}
                    </Field.Root>
                    <Field.Root disabled={manageableOrganizations.length > 0 && !isPlatformOwner}>
                      <Field.Label>組織名</Field.Label>
                      <Input value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} />
                    </Field.Root>
                    <Field.Root required>
                      <Field.Label>ロール</Field.Label>
                      <NativeSelect.Root>
                        <NativeSelect.Field value={role} onChange={(event) => setRole(event.target.value as Role)}>
                          {assignableRoles.map((assignableRole) => (
                            <option key={assignableRole} value={assignableRole}>
                              {assignableRole}
                            </option>
                          ))}
                        </NativeSelect.Field>
                        <NativeSelect.Indicator />
                      </NativeSelect.Root>
                      <Field.HelperText>{roleDescriptions[role]}</Field.HelperText>
                    </Field.Root>
                    {createdUser && (
                      <Box borderWidth="1px" borderColor="border.weak" borderRadius="8px" p="4">
                        <VStack align="stretch" gap="3">
                          <HStack justify="space-between" gap="3" align="center">
                            <Text color="gray.700" fontSize="sm" fontWeight="bold">
                              発行情報
                            </Text>
                            <Button type="button" onClick={handleCopyIssuedUser} disabled={isCopying}>
                              {isCopying ? "コピー中" : "コピー"}
                            </Button>
                          </HStack>
                          <Textarea value={issuedUserText} readOnly rows={8} fontFamily="mono" fontSize="sm" />
                        </VStack>
                      </Box>
                    )}
                    {createdUser ? (
                      <Button type="button" variant="tertiary" onClick={handleIssueAnotherUser}>
                        続けて発行
                      </Button>
                    ) : (
                      <Button type="submit" disabled={isLoading || assignableRoles.length === 0}>
                        {isLoading ? "発行中" : "発行"}
                      </Button>
                    )}
                  </VStack>
                </Box>
              </Tabs.Content>
              <Tabs.Content value="batch" pt="5">
                <VStack align="stretch" gap="3">
                  <Box>
                    <Heading fontSize="md">CSV一括発行</Heading>
                    <Text color="gray.600" fontSize="sm" mt="1">
                      CSVから複数ユーザーをまとめて発行します。列は {csvHeaders.join(", ")} を使用してください。
                      password が空の場合は一時パスワードを自動生成します。
                    </Text>
                  </Box>
                  <HStack gap="3" align="flex-end" flexWrap="wrap">
                    <Field.Root maxW="520px">
                      <Field.Label>CSVファイル</Field.Label>
                      <Input
                        type="file"
                        accept=".csv,text/csv"
                        onChange={(event) => handleBatchCsvFile(event.target.files?.[0] ?? null)}
                      />
                      <Field.HelperText>
                        {batchFileName
                          ? `${batchFileName} / ${batchUsers.length}件を読み込み済み`
                          : "email は必須です。組織やロールが空の場合は現在の入力値を使います。"}
                      </Field.HelperText>
                    </Field.Root>
                    <Button type="button" variant="tertiary" onClick={handleDownloadCsvTemplate}>
                      テンプレート
                    </Button>
                    <Button
                      type="button"
                      onClick={handleBatchSubmit}
                      disabled={isBatchLoading || batchUsers.length === 0 || assignableRoles.length === 0}
                    >
                      {isBatchLoading ? "一括発行中" : "一括発行"}
                    </Button>
                  </HStack>
                  {batchUsers.length > 0 && (
                    <Text color="gray.700" fontSize="sm">
                      読み込み済み: {batchUsers.length}件
                    </Text>
                  )}
                  {batchResults.length > 0 && (
                    <Box borderWidth="1px" borderColor="border.weak" borderRadius="8px" p="4">
                      <VStack align="stretch" gap="3">
                        <HStack justify="space-between" gap="3" align="center">
                          <Text color="gray.700" fontSize="sm" fontWeight="bold">
                            一括発行結果: 成功 {batchSuccessCount}件 / 失敗 {batchFailureCount}件
                          </Text>
                          <Button
                            type="button"
                            onClick={handleCopyBatchIssuedUsers}
                            disabled={isBatchCopying || !batchIssuedUserText}
                          >
                            {isBatchCopying ? "コピー中" : "成功分をコピー"}
                          </Button>
                        </HStack>
                        {batchIssuedUserText && (
                          <Textarea value={batchIssuedUserText} readOnly rows={8} fontFamily="mono" fontSize="sm" />
                        )}
                        {batchFailureCount > 0 && (
                          <VStack align="stretch" gap="1">
                            {batchResults
                              .filter((result) => !result.success)
                              .map((result) => (
                                <Text key={result.row} color="red.600" fontSize="sm">
                                  {result.row}行目: {result.error || "発行できませんでした。"}
                                </Text>
                              ))}
                          </VStack>
                        )}
                      </VStack>
                    </Box>
                  )}
                </VStack>
              </Tabs.Content>
              <Tabs.Content value="metadata" pt="5">
                <VStack align="stretch" gap="3">
                  <Box>
                    <Heading fontSize="md">組織表示設定</Heading>
                    <Text color="gray.600" fontSize="sm" mt="1">
                      public-viewer のレポーター、アイコン、OGP画像を組織ごとに設定します。
                    </Text>
                  </Box>
                  {!selectedOrganization ? (
                    <Text color="gray.600" fontSize="sm">
                      既存の組織を選択すると設定できます。新規組織はユーザー発行後に設定してください。
                    </Text>
                  ) : (
                    <>
                      <Field.Root>
                        <Field.Label>レポーター</Field.Label>
                        <Input value={metadataReporter} onChange={(event) => setMetadataReporter(event.target.value)} />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>メッセージ</Field.Label>
                        <Textarea
                          value={metadataMessage}
                          onChange={(event) => setMetadataMessage(event.target.value)}
                          rows={4}
                        />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>ブランドカラー</Field.Label>
                        <Input
                          type="color"
                          value={metadataBrandColor}
                          onChange={(event) => setMetadataBrandColor(event.target.value)}
                          maxW="120px"
                        />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>ウェブページURL</Field.Label>
                        <Input
                          type="url"
                          value={metadataWebLink}
                          onChange={(event) => setMetadataWebLink(event.target.value)}
                        />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>プライバシーポリシーURL</Field.Label>
                        <Input
                          type="url"
                          value={metadataPrivacyLink}
                          onChange={(event) => setMetadataPrivacyLink(event.target.value)}
                        />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>利用規約URL</Field.Label>
                        <Input
                          type="url"
                          value={metadataTermsLink}
                          onChange={(event) => setMetadataTermsLink(event.target.value)}
                        />
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>icon.png</Field.Label>
                        <Input
                          type="file"
                          accept="image/png"
                          onChange={(event) => setMetadataIconFile(event.target.files?.[0] ?? null)}
                        />
                        <Field.HelperText>
                          {organizationMetadata?.has_icon_png ? "設定済み。新しいPNGを選ぶと上書きします。" : "未設定"}
                        </Field.HelperText>
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>ogp.png</Field.Label>
                        <Input
                          type="file"
                          accept="image/png"
                          onChange={(event) => setMetadataOgpFile(event.target.files?.[0] ?? null)}
                        />
                        <Field.HelperText>
                          {organizationMetadata?.has_ogp_png ? "設定済み。新しいPNGを選ぶと上書きします。" : "未設定"}
                        </Field.HelperText>
                      </Field.Root>
                      <Field.Root>
                        <Field.Label>reporter.png</Field.Label>
                        <Input
                          type="file"
                          accept="image/png"
                          onChange={(event) => setMetadataReporterFile(event.target.files?.[0] ?? null)}
                        />
                        <Field.HelperText>
                          {organizationMetadata?.has_reporter_png
                            ? "設定済み。新しいPNGを選ぶと上書きします。"
                            : "未設定"}
                        </Field.HelperText>
                      </Field.Root>
                      <HStack justify="flex-end">
                        <Button
                          type="button"
                          variant="tertiary"
                          onClick={() => loadOrganizationMetadata(selectedOrganization.slug)}
                          disabled={isMetadataLoading || isMetadataSaving}
                        >
                          {isMetadataLoading ? "読み込み中" : "再読み込み"}
                        </Button>
                        <Button type="button" onClick={handleSaveOrganizationMetadata} disabled={isMetadataSaving}>
                          {isMetadataSaving ? "保存中" : "表示設定を保存"}
                        </Button>
                      </HStack>
                    </>
                  )}
                </VStack>
              </Tabs.Content>
              <Tabs.Content value="users" pt="5">
                <VStack align="stretch" gap="3">
                  <HStack justify="space-between" gap="3" align="center">
                    <Heading fontSize="md">発行済みユーザー</Heading>
                    <Button type="button" variant="tertiary" onClick={loadManagedUsers} disabled={isUsersLoading}>
                      {isUsersLoading ? "更新中" : "更新"}
                    </Button>
                  </HStack>
                  {isPlatformOwner && (
                    <Field.Root>
                      <Field.Label>表示する組織</Field.Label>
                      <NativeSelect.Root>
                        <NativeSelect.Field
                          value={managedUsersOrganizationSlug}
                          onChange={(event) => setManagedUsersOrganizationSlug(event.target.value)}
                        >
                          <option value="">すべての組織</option>
                          {manageableOrganizations.map((organization) => (
                            <option key={organization.id} value={organization.slug}>
                              {organization.slug} / {organization.name}
                            </option>
                          ))}
                        </NativeSelect.Field>
                        <NativeSelect.Indicator />
                      </NativeSelect.Root>
                    </Field.Root>
                  )}
                  {managedUsers.length === 0 ? (
                    <Text color="gray.600" fontSize="sm">
                      管理できるユーザーはまだありません。
                    </Text>
                  ) : (
                    <VStack align="stretch" gap="2">
                      {managedUsers.map((user) => (
                        <HStack
                          key={`${user.organization_slug}:${user.user_id}`}
                          justify="space-between"
                          gap="3"
                          borderWidth="1px"
                          borderColor="border.weak"
                          borderRadius="8px"
                          p="3"
                        >
                          <Box minW="0">
                            <Text fontSize="sm" fontWeight="bold">
                              {user.email || user.user_id}
                            </Text>
                            <Text color="gray.600" fontSize="xs">
                              {user.display_name || "表示名なし"} / {user.organization_slug} / {user.role}
                            </Text>
                          </Box>
                          <Button
                            type="button"
                            variant="tertiary"
                            aria-label={`${user.email || user.user_id} を削除`}
                            disabled={!user.can_delete || deletingUserId === user.user_id}
                            onClick={() => handleDeleteUser(user)}
                          >
                            {deletingUserId === user.user_id ? "削除中" : "削除"}
                          </Button>
                        </HStack>
                      ))}
                    </VStack>
                  )}
                </VStack>
              </Tabs.Content>
            </Tabs.Root>
          </>
        )}
      </VStack>
    </Box>
  );
}
