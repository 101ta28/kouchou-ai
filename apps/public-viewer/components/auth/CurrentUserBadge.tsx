"use client";

import { getApiBaseUrl } from "@/app/utils/api";
import { createClient } from "@/app/utils/supabase/client";
import { HStack, Text, VStack } from "@chakra-ui/react";
import { Building2, PenLine, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";

type CurrentUser = {
  email?: string;
  displayName?: string;
  platformOwner: boolean;
  canCreateReports: boolean;
  organizations: Array<{
    id: string;
    slug: string;
    name: string;
    role: string;
  }>;
};

function getAdminCreateUrl() {
  const configuredUrl = process.env.NEXT_PUBLIC_ADMIN_BASEPATH;
  if (configuredUrl) {
    return new URL("/create", configuredUrl).toString();
  }

  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return `${window.location.protocol}//${window.location.hostname}:4000/create`;
  }

  return null;
}

export function CurrentUserBadge() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [adminCreateUrl, setAdminCreateUrl] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadCurrentUser() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!isMounted || !user || !session?.access_token) {
        return;
      }

      const response = await fetch(`${getApiBaseUrl()}/current-user/context`, {
        headers: {
          "x-api-key": process.env.NEXT_PUBLIC_PUBLIC_API_KEY || "",
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      if (!response.ok) {
        return;
      }
      const context: {
        email?: string;
        display_name?: string;
        platform_owner: boolean;
        can_create_reports: boolean;
        organizations: CurrentUser["organizations"];
      } = await response.json();

      if (!isMounted) {
        return;
      }

      setCurrentUser({
        email: context.email ?? user.email ?? undefined,
        displayName:
          context.display_name ??
          (typeof user.user_metadata?.display_name === "string" ? user.user_metadata.display_name : undefined),
        platformOwner: context.platform_owner,
        canCreateReports: context.can_create_reports,
        organizations: context.organizations,
      });
      setAdminCreateUrl(getAdminCreateUrl());
    }

    loadCurrentUser();

    return () => {
      isMounted = false;
    };
  }, []);

  if (!currentUser) {
    return null;
  }

  const primaryOrganization = currentUser.organizations[0];
  const organizationLabel = currentUser.platformOwner
    ? "Platform owner"
    : primaryOrganization
      ? `${primaryOrganization.name} / ${primaryOrganization.role}`
      : "組織未設定";

  return (
    <HStack gap="3">
      {currentUser.canCreateReports && adminCreateUrl && (
        <Button size="xs" variant="secondary" asChild>
          <a href={adminCreateUrl} target="_blank" rel="noopener noreferrer">
            <PenLine />
            レポート作成
          </a>
        </Button>
      )}
      <HStack
        gap="2"
        maxW={{ base: "170px", md: "320px" }}
        minH="44px"
        px="3"
        borderWidth="1px"
        borderColor="border.weak"
        borderRadius="8px"
        color="gray.700"
      >
        <UserRound size={16} />
        <VStack align="start" gap="0" minW="0">
          <Text fontSize="sm" truncate title={currentUser.email}>
            {currentUser.displayName || currentUser.email}
          </Text>
          <HStack gap="1" minW="0" color="gray.500">
            <Building2 size={12} />
            <Text fontSize="xs" truncate title={organizationLabel}>
              {organizationLabel}
            </Text>
          </HStack>
        </VStack>
      </HStack>
    </HStack>
  );
}
