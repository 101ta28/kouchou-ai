import { getApiUrl } from "@/app/utils/api";
import { getImageFromServerSrc } from "@/app/utils/image-src";
import type { Meta } from "@/type";
import { Image } from "@chakra-ui/react";
import { ReporterContent } from "./ReporterContent";

const imagePath = "/meta/reporter.png";

function getReporterImagePath(meta: Meta) {
  if (!meta.organizationSlug) {
    return imagePath;
  }
  return `${imagePath}?organization_slug=${encodeURIComponent(meta.organizationSlug)}`;
}

async function hasReporterImage(meta: Meta) {
  const url = getApiUrl(getReporterImagePath(meta));
  if (!url) {
    return false;
  }

  try {
    const res = await fetch(url);
    return res.status === 200;
  } catch {
    return false;
  }
}

async function ReporterImage({
  meta,
  reporterName,
}: {
  meta: Meta;
  reporterName: string;
}) {
  const reporterImagePath = getReporterImagePath(meta);
  if (await hasReporterImage(meta)) {
    return <Image src={getImageFromServerSrc(reporterImagePath)} alt={reporterName} maxW="150px" />;
  }
  return null;
}

export async function Reporter({ meta }: { meta: Meta }) {
  return (
    <ReporterContent meta={meta}>
      <ReporterImage meta={meta} reporterName={meta.reporter} />
    </ReporterContent>
  );
}
