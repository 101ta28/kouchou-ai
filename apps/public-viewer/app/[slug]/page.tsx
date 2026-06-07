import { ApiConnectionError } from "@/components/ApiConnectionError";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { Analysis } from "@/components/report/Analysis";
import { BackButton } from "@/components/report/BackButton";
import { ClientContainer } from "@/components/report/ClientContainer";
import { Overview } from "@/components/report/Overview";
import { Reporter } from "@/components/reporter/Reporter";
import type { Meta, Report, Result } from "@/type";
import { ReportVisibility } from "@/type";
import { Box, Button, Card, HStack, Separator, SimpleGrid, Text, VStack } from "@chakra-ui/react";
import { DownloadIcon } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSampleScenario, isSampleSiteEnabled, sampleMeta, sampleReports, sampleResults } from "../sample-site/data";
import { getApiBaseUrl } from "../utils/api";
import { createStaticBuildFetchError, getStaticBuildReportSlugs, isStaticExportBuild } from "../utils/static-build";

type PageProps = {
  params: Promise<{
    slug: string;
  }>;
};

// ISR 5分おきにレポート更新確認
export const revalidate = 300;

export async function generateStaticParams() {
  if (isSampleSiteEnabled()) {
    return sampleReports.map((report) => ({ slug: report.slug }));
  }

  if (!isStaticExportBuild()) {
    return [];
  }

  let reports: Report[];

  try {
    const response = await fetch(`${getApiBaseUrl()}/reports`, {
      headers: {
        "x-api-key": process.env.NEXT_PUBLIC_PUBLIC_API_KEY || "",
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch reports: ${response.status} ${response.statusText}`);
    }
    reports = await response.json();
  } catch (error) {
    if (isStaticExportBuild()) {
      throw createStaticBuildFetchError(error);
    }

    return [];
  }

  return getStaticBuildReportSlugs(reports);
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  if (isSampleSiteEnabled()) {
    const slug = (await params).slug;
    const result = sampleResults[slug];
    if (!result) {
      return {};
    }

    return {
      title: `${result.config.question} - ${sampleMeta.reporter}`,
      description: result.overview,
    };
  }

  if (!isStaticExportBuild()) {
    return {
      title: "広聴AI",
    };
  }

  try {
    const slug = (await params).slug;
    const metaResponse = await fetch(`${getApiBaseUrl()}/meta/metadata.json`, {
      next: { tags: ["meta"] },
    });
    const resultResponse = await fetch(`${getApiBaseUrl()}/reports/${slug}`, {
      headers: {
        "x-api-key": process.env.NEXT_PUBLIC_PUBLIC_API_KEY || "",
        "Content-Type": "application/json",
      },
      next: { tags: [`report-${slug}`] },
    });
    if (!metaResponse.ok || !resultResponse.ok) {
      return {};
    }

    const { getBasePath } = await import("@/app/utils/image-src");

    const meta: Meta = await metaResponse.json();
    const result: Result = await resultResponse.json();
    const metaData: Metadata = {
      title: `${result.config.question} - ${meta.reporter}`,
      description: `${result.overview}`,
    };

    // visibilityが"unlisted"の場合、noindexを設定
    if (result.visibility === ReportVisibility.UNLISTED) {
      metaData.robots = {
        index: false,
        follow: false,
      };
    }

    // 静的エクスポート時はmetadataBaseを設定しない（相対パスを使用するため）
    if (process.env.NEXT_PUBLIC_OUTPUT_MODE !== "export") {
      // 開発環境やSSR時のみmetadataBaseを設定
      const defaultHost = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
      metaData.metadataBase = new URL(defaultHost + getBasePath());
    }

    if (process.env.NEXT_PUBLIC_OUTPUT_MODE === "export") {
      metaData.openGraph = {
        images: [`${slug}/opengraph-image.png`],
      };
    }

    return metaData;
  } catch (_e) {
    return {};
  }
}

export default async function Page({ params }: PageProps) {
  const slug = (await params).slug;

  if (isSampleSiteEnabled()) {
    const result = sampleResults[slug];
    if (!result) {
      notFound();
    }

    return <ReportPage meta={sampleMeta} result={result} scenario={getSampleScenario(slug)} />;
  }

  const apiUrl = getApiBaseUrl();

  let metaResponse: Response;
  let resultResponse: Response;

  try {
    metaResponse = await fetch(`${apiUrl}/meta/metadata.json`, {
      next: { tags: ["meta"] },
    });
    resultResponse = await fetch(`${apiUrl}/reports/${slug}`, {
      headers: {
        "x-api-key": process.env.NEXT_PUBLIC_PUBLIC_API_KEY || "",
        "Content-Type": "application/json",
      },
      next: { tags: [`report-${slug}`] },
    });
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    return <ApiConnectionError apiUrl={apiUrl} errorMessage={errorMessage} isServerSide={true} />;
  }

  if (metaResponse.status === 404 || resultResponse.status === 404) {
    notFound();
  }

  const meta: Meta = await metaResponse.json();
  const result: Result = await resultResponse.json();

  return <ReportPage meta={meta} result={result} />;
}

function ReportPage({
  meta,
  result,
  scenario,
}: {
  meta: Meta;
  result: Result;
  scenario?: ReturnType<typeof getSampleScenario>;
}) {
  return (
    <>
      <Header />
      <Box className="container" mt="8">
        {scenario && (
          <Card.Root maxW="750px" mx="auto" mb={8} borderLeftWidth={10} borderLeftColor={meta.brandColor || "#2577b1"}>
            <Card.Body>
              <Card.Title>
                <Text fontSize="lg" fontWeight="bold" mb={2}>
                  {scenario.useCase}のサンプル
                </Text>
              </Card.Title>
              <Card.Description>
                <Text mb={3}>想定読者: {scenario.audience}</Text>
                <Text mb={4}>{scenario.readGuide}</Text>
                <HStack>
                  <Button size="sm" variant="outline" asChild>
                    <a href={scenario.csvPath} download>
                      <DownloadIcon size={16} />
                      サンプルCSV
                    </a>
                  </Button>
                </HStack>
                {scenario.dataGuide && <SampleDataGuide scenario={scenario} result={result} />}
              </Card.Description>
            </Card.Body>
          </Card.Root>
        )}
        <Overview result={result} />
        <ClientContainer result={result} />
        <Analysis result={result} />
        <BackButton />
        <Separator my={12} maxW={"750px"} mx={"auto"} />
        <Box maxW={"750px"} mx={"auto"} mb={24}>
          <Reporter meta={meta} />
        </Box>
      </Box>
      <Footer meta={meta} />
    </>
  );
}

function SampleDataGuide({
  scenario,
  result,
}: {
  scenario: NonNullable<ReturnType<typeof getSampleScenario>>;
  result: Result;
}) {
  if (!scenario.dataGuide) {
    return null;
  }

  const sampleArguments = result.arguments.slice(0, 2);

  return (
    <Box mt={5} pt={5} borderTopWidth="1px" borderColor="gray.200">
      <Text fontWeight="bold" mb={2}>
        入力データに必要な情報
      </Text>
      <Text mb={4}>{scenario.dataGuide.summary}</Text>
      <SimpleGrid columns={{ base: 1, md: 2 }} gap={4} mb={4}>
        <ColumnGuide title="必須列" columns={scenario.dataGuide.requiredColumns} />
        <ColumnGuide title="推奨する属性列" columns={scenario.dataGuide.recommendedColumns} />
      </SimpleGrid>
      <Box mb={4}>
        <Text fontWeight="bold" mb={2}>
          よいデータの条件
        </Text>
        <VStack alignItems="stretch" gap={1}>
          {scenario.dataGuide.qualityNotes.map((note) => (
            <Text key={note}>・{note}</Text>
          ))}
        </VStack>
      </Box>
      <Box>
        <Text fontWeight="bold" mb={2}>
          データ例
        </Text>
        <VStack alignItems="stretch" gap={3}>
          {sampleArguments.map((argument) => (
            <Box key={argument.arg_id} borderWidth="1px" borderColor="gray.200" borderRadius="md" p={3}>
              <Text mb={2}>{argument.argument}</Text>
              {argument.attributes && (
                <HStack gap={2} flexWrap="wrap">
                  {Object.entries(argument.attributes).map(([key, value]) => (
                    <Text key={key} fontSize="xs" bg="gray.100" color="gray.700" px={2} py={1} borderRadius="sm">
                      {key}: {value}
                    </Text>
                  ))}
                </HStack>
              )}
            </Box>
          ))}
        </VStack>
      </Box>
    </Box>
  );
}

function ColumnGuide({ title, columns }: { title: string; columns: [name: string, description: string][] }) {
  return (
    <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" p={3}>
      <Text fontWeight="bold" mb={2}>
        {title}
      </Text>
      <VStack alignItems="stretch" gap={2}>
        {columns.map(([name, description]) => (
          <Box key={name}>
            <Text as="span" fontFamily="mono" fontWeight="bold">
              {name}
            </Text>
            <Text as="span">: {description}</Text>
          </Box>
        ))}
      </VStack>
    </Box>
  );
}
