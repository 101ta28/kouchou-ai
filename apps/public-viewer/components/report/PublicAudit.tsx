"use client";

import { getRelativeUrl } from "@/app/utils/image-src";
import {
  AUDIT_PAGE_SIZE,
  type PublicAuditPage,
  type PublicAuditRecord,
  fetchPublicAuditZip,
  fetchPublicAudits,
} from "@/app/utils/public-audit";
import { isStaticExportBuild } from "@/app/utils/static-build";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { auditMessages } from "@/lib/i18n/audit-messages";
import { Box, Button, Flex, Heading, Link, Text } from "@chakra-ui/react";
import { useEffect, useRef, useState } from "react";

export function PublicAudit({ slug }: { slug: string }) {
  const { language } = useLanguage();
  const text = auditMessages[language];
  const [page, setPage] = useState<PublicAuditPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState(false);
  const [downloadState, setDownloadState] = useState<"idle" | "loading" | "saved" | "error">("idle");
  const downloading = useRef<AbortController | null>(null);
  useEffect(() => () => downloading.current?.abort(), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh deliberately reruns the request after an error.
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let active = true;
    setPage(null);
    setError(false);
    fetchPublicAudits(slug, offset, controller.signal)
      .then((value) => {
        if (active) setPage(value);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [slug, offset, refresh]);

  const retry = () => {
    setOffset(0);
    setRefresh((value) => value + 1);
    setDownloadState("idle");
  };
  const date = (value: string) =>
    new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  async function download(row: PublicAuditRecord) {
    downloading.current?.abort();
    const controller = new AbortController();
    downloading.current = controller;
    const timeout = setTimeout(() => controller.abort(), 60000);
    setDownloadState("loading");
    try {
      const blob = await fetchPublicAuditZip(slug, row, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `public-audit-${row.run_id}-${row.release_id.slice(0, 12)}.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloadState("saved");
    } catch {
      setDownloadState("error");
    } finally {
      clearTimeout(timeout);
    }
  }

  return (
    <Box as="section" aria-labelledby="public-audit-title" maxW="750px" mx="auto" mb={12} borderTopWidth="1px" pt={8}>
      <Heading id="public-audit-title" fontSize="xl" mb={3}>
        {text.title}
      </Heading>
      <Text mb={2}>{text.description}</Text>
      <Text fontSize="sm" color="gray.600" mb={5}>
        {text.scope}
      </Text>
      {isStaticExportBuild() && (
        <Text fontSize="sm" mb={4}>
          {text.snapshot}
          {page?.exported_at && ` ${text.exported}: ${date(page.exported_at)}`}
        </Text>
      )}
      {error ? (
        <Box role="alert" mb={4}>
          <Text mb={2}>{text.error}</Text>
          <Button variant="outline" onClick={retry}>
            {text.retry}
          </Button>
        </Box>
      ) : page === null ? (
        <Text as="output" display="block" mb={4}>
          {text.loading}
        </Text>
      ) : page.total === 0 ? (
        <Text mb={4}>{text.empty}</Text>
      ) : (
        <>
          <Box as="ul" listStyleType="none" m={0} p={0}>
            {page.records.map((row) => (
              <Box as="li" key={`${row.run_id}-${row.release_id}`} py={5} borderTopWidth="1px">
                <Flex gap={3} alignItems="start" justifyContent="space-between" flexWrap="wrap">
                  <Box>
                    <Heading as="h3" fontSize="md" mb={1}>
                      {text.kinds[row.kind]}
                    </Heading>
                    <Text fontSize="sm">
                      {text.executed}: <time dateTime={row.started_at}>{date(row.started_at)}</time>
                    </Text>
                    <Text fontSize="sm" color="gray.600">
                      {text.published}: <time dateTime={row.published_at}>{date(row.published_at)}</time>
                    </Text>
                    {row.status === "failed" && <Text fontSize="sm">{text.failed}</Text>}
                  </Box>
                  <Button
                    variant="outline"
                    whiteSpace="normal"
                    height="auto"
                    minH="44px"
                    py={2}
                    maxW="100%"
                    disabled={downloadState === "loading"}
                    onClick={() => download(row)}
                  >
                    {text.download}
                  </Button>
                </Flex>
                <Box as="details" mt={3} fontSize="sm">
                  <Box as="summary" cursor="pointer" width="fit-content">
                    {text.details}
                  </Box>
                  <Box as="dl" mt={2}>
                    {[
                      [text.run, row.run_id],
                      [text.release, row.release_id],
                      [text.sha, row.archive_sha256],
                    ].map(([label, value]) => (
                      <Box key={label} mb={2}>
                        <Text as="dt" color="gray.600">
                          {label}
                        </Text>
                        <Box as="dd" m={0} overflowWrap="anywhere">
                          <code>{value}</code>
                        </Box>
                      </Box>
                    ))}
                  </Box>
                </Box>
              </Box>
            ))}
          </Box>
          {(page.total > AUDIT_PAGE_SIZE || offset > 0) && (
            <Flex gap={3} mb={4} alignItems="center" flexWrap="wrap">
              <Button
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - AUDIT_PAGE_SIZE))}
              >
                {text.previous}
              </Button>
              <Text fontSize="sm">
                {page.records.length ? offset + 1 : 0}–{offset + page.records.length} / {page.total}
              </Text>
              <Button
                variant="outline"
                disabled={offset + page.records.length >= page.total}
                onClick={() => setOffset(offset + AUDIT_PAGE_SIZE)}
              >
                {text.next}
              </Button>
            </Flex>
          )}
        </>
      )}
      {downloadState !== "idle" && (
        <Box mb={4} role={downloadState === "error" ? "alert" : "status"}>
          <Text>
            {downloadState === "loading"
              ? text.downloading
              : downloadState === "saved"
                ? text.downloaded
                : text.downloadError}
          </Text>
          {downloadState === "error" && (
            <Button variant="outline" mt={2} onClick={retry}>
              {text.retry}
            </Button>
          )}
        </Box>
      )}
      <Link href={getRelativeUrl("/audit-tools/guide.html")} textDecoration="underline">
        {text.tools}
      </Link>
      <Text fontSize="sm" color="gray.600" mt={1}>
        {text.toolsNote}
      </Text>
    </Box>
  );
}
