"use client";

import { createClient } from "@/app/utils/supabase/client";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <Button type="button" variant="tertiary" size="xs" onClick={handleLogout}>
      <LogOut size={16} />
      ログアウト
    </Button>
  );
}
