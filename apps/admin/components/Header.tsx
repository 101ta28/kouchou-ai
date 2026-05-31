import { isAuthEnabled } from "@/app/utils/supabase/env";
import { Alert, Box, Flex, Image } from "@chakra-ui/react";
import { Users } from "lucide-react";
import Link from "next/link";
import { LogoutButton } from "./auth/LogoutButton";
import { Button } from "./ui/button";

export function Header() {
  return (
    <Box py="5" px="6" bg="white">
      <Flex maxW="1200px" mx="auto" justifyContent="space-between" alignItems="center">
        <Link href="/">
          <Image src="/images/logo.svg" alt="広聴AI" cursor="pointer" />
        </Link>
        <Flex gap="4" alignItems="center">
          <Alert.Root status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title fontSize={"md"}>管理者画面</Alert.Title>
              <Alert.Description>このページはレポート作成者向けの管理画面です</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          {isAuthEnabled() && (
            <>
              <Button asChild variant="tertiary" size="xs">
                <Link href="/users">
                  <Users size={16} />
                  ユーザー発行
                </Link>
              </Button>
              <LogoutButton />
            </>
          )}
        </Flex>
      </Flex>
    </Box>
  );
}
