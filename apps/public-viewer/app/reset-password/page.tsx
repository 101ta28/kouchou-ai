import { Box } from "@chakra-ui/react";
import { Suspense } from "react";
import { ResetPasswordForm } from "./ResetPasswordForm";

export default function ResetPasswordPage() {
  return (
    <Box className="container" bgColor="bg.secondary" minH="100vh">
      <Box mx="auto" maxW="440px" px="6" py="16">
        <Suspense fallback={null}>
          <ResetPasswordForm />
        </Suspense>
      </Box>
    </Box>
  );
}
