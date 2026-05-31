"use client";

import { getApiBaseUrl } from "@/app/utils/api";
import { createClient } from "@/app/utils/supabase/client";
import { Button } from "@/components/ui/button";
import { Box, Field, HStack, Heading, Input, NativeSelect, Text, Textarea, VStack } from "@chakra-ui/react";
import { type FormEvent, useState } from "react";

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

export function UserIssueForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [organizationSlug, setOrganizationSlug] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [isLoading, setIsLoading] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [createdUser, setCreatedUser] = useState<IssuedUser | null>(null);

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
          organization_name: organizationName || null,
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
        organization_name: organizationName || organizationSlug,
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
          <Input
            value={organizationSlug}
            onChange={(event) => setOrganizationSlug(event.target.value.toLowerCase())}
            pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
          />
        </Field.Root>
        <Field.Root>
          <Field.Label>組織名</Field.Label>
          <Input value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} />
        </Field.Root>
        <Field.Root required>
          <Field.Label>ロール</Field.Label>
          <NativeSelect.Root>
            <NativeSelect.Field value={role} onChange={(event) => setRole(event.target.value as Role)}>
              <option value="viewer">viewer</option>
              <option value="creator">creator</option>
              <option value="admin">admin</option>
              <option value="owner">owner</option>
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
        <Button type="submit" disabled={isLoading}>
          {isLoading ? "発行中" : "発行"}
        </Button>
      </VStack>
    </Box>
  );
}
