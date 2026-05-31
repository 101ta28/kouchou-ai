"use client";

import { getApiBaseUrl } from "@/app/utils/api";
import { createClient } from "@/app/utils/supabase/client";
import { Button } from "@/components/ui/button";
import { Box, Field, HStack, Heading, Input, NativeSelect, Text, Textarea, VStack } from "@chakra-ui/react";
import { type FormEvent, useEffect, useState } from "react";

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

type ManageableOrganization = {
  id: string;
  slug: string;
  name: string;
  role: "platform_owner" | "owner" | "admin";
  assignable_roles: Role[];
};

export function UserIssueForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [organizationSlug, setOrganizationSlug] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [isPlatformOwner, setIsPlatformOwner] = useState(false);
  const [manageableOrganizations, setManageableOrganizations] = useState<ManageableOrganization[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [createdUser, setCreatedUser] = useState<IssuedUser | null>(null);

  const selectedOrganization = manageableOrganizations.find((organization) => organization.slug === organizationSlug);
  const assignableRoles =
    selectedOrganization?.assignable_roles ??
    (isPlatformOwner
      ? (["viewer", "creator", "admin", "owner"] satisfies Role[])
      : (["viewer", "creator"] satisfies Role[]));

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

  useEffect(() => {
    let isMounted = true;

    async function loadUserManagementContext() {
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();

        const response = await fetch(`${getApiBaseUrl()}/admin/user-management/context`, {
          headers: {
            "x-api-key": process.env.NEXT_PUBLIC_ADMIN_API_KEY || "",
            ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
          },
        });

        if (!response.ok) {
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
      }
    }

    loadUserManagementContext();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (selectedOrganization && !selectedOrganization.assignable_roles.includes(role)) {
      setRole(selectedOrganization.assignable_roles[0] ?? "viewer");
    }
  }, [role, selectedOrganization]);

  async function handleSubmit(event: FormEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsLoading(true);
    setMessage(null);
    setCreatedUser(null);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const response = await fetch(`${getApiBaseUrl()}/admin/users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.NEXT_PUBLIC_ADMIN_API_KEY || "",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
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
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ユーザーを発行できませんでした。");
    } finally {
      setIsLoading(false);
    }
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

  return (
    <Box
      as="form"
      onSubmit={handleSubmit}
      bg="white"
      borderWidth="1px"
      borderColor="border.weak"
      borderRadius="8px"
      p="8"
    >
      <VStack gap="5" align="stretch">
        <Heading fontSize="xl">ユーザー発行</Heading>
        <Field.Root required>
          <Field.Label>メールアドレス</Field.Label>
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="off" />
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
                pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
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
        </Field.Root>
        {message && <Text color={createdUser ? "green.700" : "red.600"}>{message}</Text>}
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
        <Button type="submit" disabled={isLoading || assignableRoles.length === 0}>
          {isLoading ? "発行中" : "発行"}
        </Button>
      </VStack>
    </Box>
  );
}
