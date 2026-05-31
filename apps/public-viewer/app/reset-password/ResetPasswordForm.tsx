"use client";

import { createClient } from "@/app/utils/supabase/client";
import { Button } from "@/components/ui/button";
import { Box, Field, Heading, Input, Link, Text, VStack } from "@chakra-ui/react";
import NextLink from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";

export function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let isMounted = true;

    async function prepareRecoverySession() {
      const supabase = createClient();
      const code = searchParams.get("code");
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          if (isMounted) {
            setMessage(
              "パスワードリセットリンクが無効、または期限切れです。もう一度リセットメールを送信してください。",
            );
            setIsReady(false);
          }
          return;
        }
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (isMounted) {
        setIsReady(Boolean(session));
        if (!session) {
          setMessage("パスワードリセットリンクから開いてください。");
        }
      }
    }

    prepareRecoverySession();

    return () => {
      isMounted = false;
    };
  }, [searchParams]);

  async function handleSubmit(event: FormEvent<HTMLDivElement>) {
    event.preventDefault();
    setMessage(null);

    if (password !== passwordConfirmation) {
      setMessage("確認用パスワードが一致しません。");
      return;
    }

    setIsLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    setIsLoading(false);

    if (error) {
      setMessage("パスワードを更新できませんでした。リンクの期限を確認し、もう一度お試しください。");
      return;
    }

    setMessage("パスワードを更新しました。新しいパスワードでログインしてください。");
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
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
        <Heading fontSize="xl">パスワードを再設定</Heading>
        <Text color="gray.600" fontSize="sm">
          新しいパスワードを入力してください。
        </Text>
        <Field.Root required disabled={!isReady}>
          <Field.Label>新しいパスワード</Field.Label>
          <Input
            type="password"
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
          />
        </Field.Root>
        <Field.Root required disabled={!isReady}>
          <Field.Label>新しいパスワード（確認）</Field.Label>
          <Input
            type="password"
            minLength={8}
            value={passwordConfirmation}
            onChange={(event) => setPasswordConfirmation(event.target.value)}
            autoComplete="new-password"
          />
        </Field.Root>
        {message && <Text color={message.includes("更新しました") ? "green.700" : "red.600"}>{message}</Text>}
        <Button type="submit" disabled={!isReady || isLoading}>
          {isLoading ? "更新中" : "パスワードを更新"}
        </Button>
        <Link asChild color="font.link">
          <NextLink href="/login">ログイン画面に戻る</NextLink>
        </Link>
      </VStack>
    </Box>
  );
}
