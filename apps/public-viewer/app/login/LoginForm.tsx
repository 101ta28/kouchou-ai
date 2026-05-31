"use client";

import { createClient } from "@/app/utils/supabase/client";
import { Button } from "@/components/ui/button";
import { Box, Field, Heading, Input, Link, Text, VStack } from "@chakra-ui/react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLDivElement>) {
    event.preventDefault();
    setError(null);
    setIsLoading(true);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setIsLoading(false);

    if (signInError) {
      setError("メールアドレスまたはパスワードが正しくありません。");
      return;
    }

    router.replace("/");
    router.refresh();
  }

  async function handlePasswordReset() {
    setError(null);
    if (!email) {
      setError("パスワードリセットにはメールアドレスを入力してください。");
      return;
    }

    const supabase = createClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setError(
      resetError ? "パスワードリセットメールを送信できませんでした。" : "パスワードリセットメールを送信しました。",
    );
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
        <Heading fontSize="xl">レポート画面にログイン</Heading>
        <Field.Root required>
          <Field.Label>メールアドレス</Field.Label>
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
        </Field.Root>
        <Field.Root required>
          <Field.Label>パスワード</Field.Label>
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </Field.Root>
        {error && <Text color={error.includes("送信しました") ? "green.700" : "red.600"}>{error}</Text>}
        <Button type="submit" disabled={isLoading}>
          {isLoading ? "ログイン中" : "ログイン"}
        </Button>
        <Link as="button" type="button" color="font.link" onClick={handlePasswordReset} textAlign="left">
          パスワードをリセット
        </Link>
      </VStack>
    </Box>
  );
}
