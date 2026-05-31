"use client";

import { getImageFromServerSrc } from "@/app/utils/image-src";
import { isAuthEnabled } from "@/app/utils/supabase/env";
import { HStack, Image, useBreakpointValue } from "@chakra-ui/react";
import { CurrentUserBadge } from "./auth/CurrentUserBadge";
import { LogoutButton } from "./auth/LogoutButton";
import { GlobalNavigation } from "./globalNavigation/GlobalNavigation";

export function Header() {
  const logoSrc = useBreakpointValue({
    base: getImageFromServerSrc("/images/logo-sp.svg"),
    md: getImageFromServerSrc("/images/logo.svg"),
  });
  return (
    <HStack
      className="container"
      py="0"
      px="6"
      justifyContent="space-between"
      alignItems="center"
      bg="white"
      borderBottom="1px solid"
      borderColor="border.weak"
    >
      <Image src={logoSrc} alt="広聴AI" />
      <HStack gap="4">
        <GlobalNavigation />
        {isAuthEnabled() && (
          <>
            <CurrentUserBadge />
            <LogoutButton />
          </>
        )}
      </HStack>
    </HStack>
  );
}
