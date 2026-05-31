import { Box } from "@chakra-ui/react";
import { Suspense } from "react";
import { LoginForm } from "./LoginForm";

export default function LoginPage() {
  return (
    <Box className="container" bgColor="bg.secondary" minH="100vh">
      <Box mx="auto" maxW="440px" px="6" py="16">
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </Box>
    </Box>
  );
}
