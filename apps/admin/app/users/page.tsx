import { Header } from "@/components/Header";
import { Box } from "@chakra-ui/react";
import { UserIssueForm } from "./UserIssueForm";

export default function UsersPage() {
  return (
    <Box className="container" bgColor="bg.secondary">
      <Header />
      <Box mx="auto" maxW="720px" boxSizing="content-box" px="6" py="12">
        <UserIssueForm />
      </Box>
    </Box>
  );
}
